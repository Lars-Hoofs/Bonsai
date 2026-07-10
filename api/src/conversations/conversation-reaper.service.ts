import { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { TenantDbService } from '../tenancy/tenant-db.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { MetricsService } from '../metrics/metrics.service';
import { readAutoCloseSettings } from './auto-close';

/**
 * Auto-close idle conversations (#40): a scheduled reaper that periodically
 * sweeps every active tenant and closes conversations that have been idle
 * (no message / update — tracked by `conversations.updated_at`) longer than a
 * per-project configurable threshold.
 *
 * Mirrors CrawlService's cross-tenant scan (enumerate `tenants` in the
 * control-plane pool, then do the per-tenant work inside `withTenant` so the
 * search_path — and thus tenant isolation — is enforced). Unlike CrawlService
 * it needs no Redis: idle auto-close must work in the base self-hosted
 * deployment, so it runs on a plain in-process `setInterval` started by
 * ConversationsModule when `AUTO_CLOSE_ENABLED` is set.
 *
 * Constructed directly (not via a Nest factory) so it can be unit/integration
 * tested against a real Postgres without booting the whole app or a scheduler.
 */
export class ConversationReaperService {
  private readonly logger = new Logger(ConversationReaperService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly pool: Pool,
    private readonly tenantDb: TenantDbService,
    private readonly webhooks: WebhooksService,
    private readonly metrics: MetricsService,
    private readonly defaultIdleMinutes: number,
  ) {}

  /**
   * Starts the periodic sweep. The interval fires an async `sweep()`; overlap
   * is prevented by the `running` guard so a slow sweep can never stack. The
   * timer is unref'd so it doesn't keep the process alive on shutdown.
   */
  start(everyMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.sweep().catch((err) =>
        this.logger.warn(
          `Auto-close sweep failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      );
    }, everyMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * One sweep: for every active tenant, and every project in that tenant that
   * has opted into auto-close (`settings.autoCloseEnabled === true`), close
   * the still-open conversations (`status IN ('bot','handover')`) whose
   * `updated_at` is older than the project's effective idle threshold.
   *
   * Returns the total number of conversations closed (used by tests). Skips
   * overlapping runs; a failure in one tenant is logged and does not abort the
   * rest of the sweep.
   */
  async sweep(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const tenants = await this.pool.query<{ schema_name: string }>(
        `SELECT schema_name FROM tenants WHERE status = 'active'`,
      );
      let closedTotal = 0;
      for (const t of tenants.rows) {
        try {
          closedTotal += await this.sweepTenant(t.schema_name);
        } catch (err) {
          this.logger.warn(
            `Auto-close sweep failed for tenant ${t.schema_name}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      return closedTotal;
    } finally {
      this.running = false;
    }
  }

  private async sweepTenant(schemaName: string): Promise<number> {
    // Resolve which projects have auto-close enabled and their thresholds
    // from the free-form settings blob (tolerating any garbage shape).
    const projects = await this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(sql`SELECT id, settings FROM projects`);
      return r.rows as { id: string; settings: unknown }[];
    });

    let closed = 0;
    for (const project of projects) {
      const settings =
        project.settings && typeof project.settings === 'object'
          ? (project.settings as Record<string, unknown>)
          : {};
      const { enabled, idleMinutes } = readAutoCloseSettings(
        settings,
        this.defaultIdleMinutes,
      );
      if (!enabled) continue;
      closed += await this.closeIdleForProject(
        schemaName,
        project.id,
        idleMinutes,
      );
    }
    return closed;
  }

  /**
   * Closes idle open conversations for one project and dispatches a
   * `conversation.closed` webhook per closed conversation. The UPDATE is the
   * source of truth for idleness (an indexed status + updated_at comparison),
   * so concurrent sweeps or a manual close can't double-close a row.
   */
  private async closeIdleForProject(
    schemaName: string,
    projectId: string,
    idleMinutes: number,
  ): Promise<number> {
    const closedIds = await this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`UPDATE conversations
            SET status = 'closed', ended_at = now(),
                closed_reason = 'auto_idle', updated_at = now()
            WHERE project_id = ${projectId}
              AND status IN ('bot', 'handover')
              AND updated_at < now() - (${idleMinutes}::text || ' minutes')::interval
            RETURNING id`,
      );
      return (r.rows as { id: string }[]).map((row) => row.id);
    });

    for (const conversationId of closedIds) {
      this.metrics.conversationsAutoClosedTotal.inc();
      await this.webhooks.dispatch(
        schemaName,
        projectId,
        'conversation.closed',
        { conversationId, reason: 'auto_idle' },
      );
    }
    return closedIds.length;
  }
}
