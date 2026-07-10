import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { TenantDbService } from '../tenancy/tenant-db.service';
import { AuditService } from '../audit/audit.service';
import { EMBEDDING_PROVIDER } from '../knowledge/embedding/embedding-provider';
import type { EmbeddingProvider } from '../knowledge/embedding/embedding-provider';
import { clusterQuestions } from './clustering';
import type { EmbeddedQuestion, QuestionCluster } from './clustering';

export interface UnansweredQuestion {
  id: string;
  projectId: string;
  conversationId: string | null;
  messageId: string | null;
  question: string;
  language: string | null;
  confidence: number | null;
  reason: 'refused' | 'visitor_no';
  resolved: boolean;
  createdAt: string;
}

/** A suggested KB gap: a cluster of related unanswered questions editors
 * should consider writing a knowledge article for. */
export type KbGapSuggestion = QuestionCluster;

/**
 * Default cosine-similarity threshold for grouping unanswered questions into
 * KB-gap clusters. Deliberately conservative so only genuinely similar
 * questions merge; editors can override via the query param.
 */
const DEFAULT_CLUSTER_THRESHOLD = 0.6;
/** Cap on how many recent unanswered questions we embed+cluster in one call —
 * keeps the (offline) embedding round-trip and O(n*k) clustering bounded. */
const DEFAULT_CLUSTER_LIMIT = 500;

function mapRow(r: Record<string, unknown>): UnansweredQuestion {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    conversationId: (r.conversation_id as string | null) ?? null,
    messageId: (r.message_id as string | null) ?? null,
    question: r.question as string,
    language: (r.language as string | null) ?? null,
    confidence: r.confidence == null ? null : Number(r.confidence),
    reason: r.reason as 'refused' | 'visitor_no',
    resolved: r.resolved as boolean,
    createdAt: String(r.created_at),
  };
}

@Injectable()
export class UnansweredQuestionsService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly audit: AuditService,
    @Inject(EMBEDDING_PROVIDER) private readonly embedder: EmbeddingProvider,
  ) {}

  /**
   * Lists captured unanswered questions for a project. Defaults to the open
   * (unresolved) review queue, newest first; `status` widens it to resolved
   * or all.
   */
  async list(
    schemaName: string,
    projectId: string,
    opts: {
      status?: 'open' | 'resolved' | 'all';
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<UnansweredQuestion[]> {
    const status = opts.status ?? 'open';
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    return this.tenantDb.withTenant(schemaName, async (db) => {
      const resolvedFilter =
        status === 'all'
          ? sql``
          : status === 'resolved'
            ? sql`AND resolved = true`
            : sql`AND resolved = false`;
      const r = await db.execute(
        sql`SELECT * FROM unanswered_questions
            WHERE project_id = ${projectId} ${resolvedFilter}
            ORDER BY created_at DESC
            LIMIT ${limit} OFFSET ${offset}`,
      );
      return r.rows.map(mapRow);
    });
  }

  /**
   * Marks an unanswered question as resolved/unresolved (editor addressed the
   * KB gap, or wants to re-open it). Tenant+project scoped so an id from
   * another project 404s.
   */
  async setResolved(
    tenant: { id: string; schemaName: string },
    projectId: string,
    id: string,
    resolved: boolean,
    actorUserId: string,
  ): Promise<UnansweredQuestion> {
    return this.tenantDb.withTenant(tenant.schemaName, async (db) => {
      const r = await db.execute(
        sql`UPDATE unanswered_questions
            SET resolved = ${resolved}
            WHERE id = ${id} AND project_id = ${projectId}
            RETURNING *`,
      );
      const row = r.rows[0];
      if (!row) throw new NotFoundException('Unanswered question not found');
      await this.audit.record(
        {
          tenantId: tenant.id,
          actorUserId,
          action: resolved
            ? 'unanswered_question.resolved'
            : 'unanswered_question.reopened',
          resource: `unanswered_question:${id}`,
        },
        db,
      );
      return mapRow(row);
    });
  }

  /**
   * #41 — clusters the project's open unanswered questions into suggested KB
   * gaps. Embeds each question with the same self-hosted embedding layer used
   * for retrieval, then runs cosine-similarity clustering (no external
   * service). Only clusters with >= `minSize` members are returned, biggest
   * first, so editors see the most impactful gaps to write articles for.
   */
  async suggestKbGaps(
    schemaName: string,
    projectId: string,
    opts: { threshold?: number; minSize?: number; limit?: number } = {},
  ): Promise<{ analyzed: number; suggestions: KbGapSuggestion[] }> {
    const threshold = opts.threshold ?? DEFAULT_CLUSTER_THRESHOLD;
    const minSize = opts.minSize ?? 2;
    const limit = opts.limit ?? DEFAULT_CLUSTER_LIMIT;

    const questions = await this.list(schemaName, projectId, {
      status: 'open',
      limit,
    });
    if (questions.length === 0) {
      return { analyzed: 0, suggestions: [] };
    }

    const vectors = await this.embedder.embed(questions.map((q) => q.question));
    const embedded: EmbeddedQuestion[] = questions.map((q, i) => ({
      id: q.id,
      question: q.question,
      embedding: vectors[i] ?? [],
    }));

    const clusters = clusterQuestions(embedded, threshold);
    const suggestions = clusters.filter((c) => c.size >= minSize);
    return { analyzed: questions.length, suggestions };
  }
}
