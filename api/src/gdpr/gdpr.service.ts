import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { AuditService } from '../audit/audit.service';
import { PG_POOL } from '../db/db.module';
import { TenantDbService } from '../tenancy/tenant-db.service';
import {
  assembleExportBundle,
  type CitationRow,
  type ConversationRow,
  type ExportBundle,
  type FeedbackRow,
  type HandoverRow,
  type MessageRow,
} from './export-bundle';
import { retentionCutoff } from './retention';

export interface ErasureResult {
  visitorId: string;
  conversationsDeleted: number;
}

export interface PurgeProjectResult {
  schemaName: string;
  projectId: string;
  retentionDays: number;
  conversationsDeleted: number;
}

/**
 * GDPR data-subject operations (#47): export, right-to-erasure, and the
 * per-project retention auto-purge.
 *
 * A "subject" is a widget visitor identified by `conversations.visitor_id`,
 * always scoped to a single (tenant, project). Every read/mutation runs
 * inside `TenantDbService.withTenant`, whose `search_path` excludes `public`,
 * so a subject in one tenant can never reach another tenant's data.
 */
@Injectable()
export class GdprService {
  private readonly logger = new Logger(GdprService.name);

  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly audit: AuditService,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  /**
   * Assembles the full personal-data export bundle for a subject. Throws
   * 404 when the subject has no data in the (tenant, project) scope, so an
   * admin gets clear feedback rather than an empty download for a typo'd
   * visitor id.
   */
  async exportSubject(
    tenant: { id: string; schemaName: string },
    projectId: string,
    visitorId: string,
    actorUserId: string,
  ): Promise<ExportBundle> {
    const bundle = await this.tenantDb.withTenant(
      tenant.schemaName,
      async (db) => {
        const conversations = await this.selectConversations(
          db,
          projectId,
          visitorId,
        );
        if (conversations.length === 0) return null;
        const conversationIds = conversations.map((c) => c.id);

        const messages = (
          await db.execute(sql`
            SELECT id, conversation_id, role, content, confidence, refused,
                   model_used, latency_ms, created_at
            FROM messages
            WHERE conversation_id = ANY(${sql.param(conversationIds)}::uuid[])
            ORDER BY conversation_id, created_at`)
        ).rows as unknown as MessageRow[];

        const citations = (
          await db.execute(sql`
            SELECT mc.message_id, mc.ordinal, mc.document_title, mc.origin_url
            FROM message_citations mc
            JOIN messages m ON m.id = mc.message_id
            WHERE m.conversation_id = ANY(${sql.param(conversationIds)}::uuid[])
            ORDER BY mc.message_id, mc.ordinal`)
        ).rows as unknown as CitationRow[];

        const feedback = (
          await db.execute(sql`
            SELECT mf.message_id, mf.rating, mf.created_at
            FROM message_feedback mf
            JOIN messages m ON m.id = mf.message_id
            WHERE m.conversation_id = ANY(${sql.param(conversationIds)}::uuid[])
            ORDER BY mf.message_id`)
        ).rows as unknown as FeedbackRow[];

        const handovers = (
          await db.execute(sql`
            SELECT id, conversation_id, reason, started_at, returned_at
            FROM handovers
            WHERE conversation_id = ANY(${sql.param(conversationIds)}::uuid[])
            ORDER BY conversation_id, started_at`)
        ).rows as unknown as HandoverRow[];

        return assembleExportBundle({
          tenantId: tenant.id,
          projectId,
          visitorId,
          conversations,
          messages,
          citations,
          feedback,
          handovers,
          exportedAt: new Date(),
        });
      },
    );

    if (!bundle) throw new NotFoundException('No data found for subject');

    await this.audit.record({
      tenantId: tenant.id,
      actorUserId,
      action: 'gdpr.export',
      resource: `visitor:${visitorId}`,
      metadata: {
        projectId,
        conversations: bundle.counts.conversations,
        messages: bundle.counts.messages,
      },
    });
    return bundle;
  }

  /**
   * Irreversibly erases a subject's personal data. Deletes the subject's
   * conversations — messages, citations, handovers and message feedback
   * cascade via their `ON DELETE CASCADE` FKs — and clears the
   * `visitor_secret` en route (defense in depth; the row is deleted anyway).
   * The delete and its audit row commit in one tenant transaction, so the
   * erasure is either fully recorded or fully rolled back.
   */
  async eraseSubject(
    tenant: { id: string; schemaName: string },
    projectId: string,
    visitorId: string,
    actorUserId: string,
  ): Promise<ErasureResult> {
    const result = await this.tenantDb.withTenant(
      tenant.schemaName,
      async (db) => {
        const deleted = (
          await db.execute(sql`
            DELETE FROM conversations
            WHERE project_id = ${projectId} AND visitor_id = ${visitorId}
            RETURNING id`)
        ).rows;
        if (deleted.length === 0) {
          throw new NotFoundException('No data found for subject');
        }
        await this.audit.record(
          {
            tenantId: tenant.id,
            actorUserId,
            action: 'gdpr.erasure',
            resource: `visitor:${visitorId}`,
            metadata: { projectId, conversationsDeleted: deleted.length },
          },
          db,
        );
        return { visitorId, conversationsDeleted: deleted.length };
      },
    );
    this.logger.log(
      `Erased subject visitor:${visitorId} (${result.conversationsDeleted} conversations) in ${tenant.schemaName}`,
    );
    return result;
  }

  /**
   * Runs the retention auto-purge across every active tenant/project that has
   * a positive `retention_days` window, deleting conversations last active
   * before the cutoff. Idempotent and safe to call repeatedly (the scheduled
   * reaper and tests both call it). Errors on one tenant are logged and
   * skipped so a single bad schema can't stall the whole sweep.
   */
  async purgeExpired(now: Date = new Date()): Promise<PurgeProjectResult[]> {
    const tenants = (
      await this.pool.query<{ schema_name: string }>(
        `SELECT schema_name FROM tenants WHERE status = 'active'`,
      )
    ).rows;

    const results: PurgeProjectResult[] = [];
    for (const t of tenants) {
      try {
        const perProject = await this.purgeTenant(t.schema_name, now);
        results.push(...perProject);
      } catch (e) {
        this.logger.warn(
          `Retention purge failed for ${t.schema_name}: ${(e as Error).message}`,
        );
      }
    }
    return results;
  }

  /** Purges all projects with a retention window inside a single tenant. */
  private async purgeTenant(
    schemaName: string,
    now: Date,
  ): Promise<PurgeProjectResult[]> {
    return this.tenantDb.withTenant(schemaName, async (db) => {
      const projects = (
        await db.execute(sql`
          SELECT id, retention_days
          FROM projects
          WHERE retention_days IS NOT NULL AND retention_days > 0`)
      ).rows as unknown as { id: string; retention_days: number }[];

      const out: PurgeProjectResult[] = [];
      for (const p of projects) {
        const cutoff = retentionCutoff(p.retention_days, now);
        if (cutoff === null) continue;
        const deleted = (
          await db.execute(sql`
            DELETE FROM conversations
            WHERE project_id = ${p.id} AND updated_at < ${cutoff.toISOString()}
            RETURNING id`)
        ).rows;
        if (deleted.length === 0) continue;
        await this.audit.record(
          {
            actorUserId: undefined,
            action: 'gdpr.purge',
            resource: `project:${p.id}`,
            metadata: {
              schemaName,
              retentionDays: p.retention_days,
              conversationsDeleted: deleted.length,
            },
          },
          db,
        );
        out.push({
          schemaName,
          projectId: p.id,
          retentionDays: p.retention_days,
          conversationsDeleted: deleted.length,
        });
      }
      return out;
    });
  }

  private async selectConversations(
    db: NodePgDatabase,
    projectId: string,
    visitorId: string,
  ): Promise<ConversationRow[]> {
    return (
      await db.execute(sql`
        SELECT id, project_id, visitor_id, channel, status, language,
               resolution, started_at, ended_at, updated_at,
               csat_score, csat_comment
        FROM conversations
        WHERE project_id = ${projectId} AND visitor_id = ${visitorId}
        ORDER BY started_at`)
    ).rows as unknown as ConversationRow[];
  }
}
