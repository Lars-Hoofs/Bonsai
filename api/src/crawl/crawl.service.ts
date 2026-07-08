import { Logger } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { TenantDbService } from '../tenancy/tenant-db.service';
import { IngestionService } from '../knowledge/ingestion/ingestion.service';

const QUEUE = 'recrawl';

/** Matches IngestionService's DEFAULT_STALE_MS fallback for direct
 * construction (no AppConfig) — kept in sync manually since CrawlService, like
 * IngestionService, is constructed directly (not via Nest DI) in some paths. */
const DEFAULT_STALE_MS = 900_000;

interface RecrawlJob {
  schemaName: string;
  sourceId: string;
}

/**
 * Background re-crawl of website sources via BullMQ (Redis). A repeatable
 * `scan` job periodically walks every active tenant's website sources and
 * enqueues a `recrawl` job per source; the worker re-runs ingestion, which is
 * cheap for unchanged pages thanks to content-hash change detection.
 *
 * Constructed directly (not via a Nest factory) so it can be unit/integration
 * tested against a real Redis without booting the whole app.
 */
export class CrawlService {
  private readonly logger = new Logger(CrawlService.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    private readonly redisUrl: string,
    private readonly pool: Pool,
    private readonly tenantDb: TenantDbService,
    private readonly ingestion: IngestionService,
    private readonly staleMs: number = DEFAULT_STALE_MS,
  ) {}

  private connection(): { host: string; port: number } {
    const u = new URL(this.redisUrl);
    return { host: u.hostname, port: Number(u.port) || 6379 };
  }

  start(): void {
    const connection = this.connection();
    this.queue = new Queue(QUEUE, { connection });
    this.worker = new Worker<RecrawlJob | Record<string, never>>(
      QUEUE,
      async (job) => {
        if (job.name === 'scan') {
          await this.scanAndEnqueueAll();
          return;
        }
        const { schemaName, sourceId } = job.data as RecrawlJob;
        await this.ingestion.ingestSource(schemaName, sourceId);
      },
      { connection },
    );
    this.worker.on('failed', (job, err) =>
      this.logger.warn(`Re-crawl job ${job?.id ?? '?'} failed: ${err.message}`),
    );
  }

  /** Registers a repeatable scan so re-crawl runs on an interval. */
  async scheduleRecurring(everyMs: number): Promise<void> {
    if (!this.queue) throw new Error('CrawlService not started');
    await this.queue.add(
      'scan',
      {},
      { repeat: { every: everyMs }, jobId: 'recrawl-scan' },
    );
  }

  async enqueueRecrawl(schemaName: string, sourceId: string): Promise<void> {
    if (!this.queue) throw new Error('CrawlService not started');
    await this.queue.add('recrawl', { schemaName, sourceId });
  }

  /**
   * Walks every active tenant's website sources and enqueues a re-crawl each.
   *
   * Includes sources stuck in 'processing' past the stale threshold (a
   * crashed prior run that never reached its catch block) so they self-heal
   * on the next scheduled scan rather than staying stuck forever — not just
   * sources already sitting at 'processed'.
   */
  async scanAndEnqueueAll(): Promise<number> {
    const tenants = await this.pool.query<{ schema_name: string }>(
      `SELECT schema_name FROM tenants WHERE status = 'active'`,
    );
    let enqueued = 0;
    for (const t of tenants.rows) {
      const sources = await this.tenantDb.withTenant(t.schema_name, (db) =>
        db.execute(
          sql`SELECT id FROM knowledge_sources
              WHERE type = 'website'
                AND (status <> 'processing' OR updated_at < now() - (${this.staleMs}::text || ' milliseconds')::interval)`,
        ),
      );
      for (const row of sources.rows as { id: string }[]) {
        await this.enqueueRecrawl(t.schema_name, row.id);
        enqueued++;
      }
    }
    return enqueued;
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
