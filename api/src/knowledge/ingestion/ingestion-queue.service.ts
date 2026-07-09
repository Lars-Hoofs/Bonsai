import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { APP_CONFIG } from '../../config/config';
import type { AppConfig } from '../../config/config';
import { IngestionService } from './ingestion.service';

interface IngestJob {
  schemaName: string;
  sourceId: string;
}

const QUEUE = 'ingestion';

/**
 * Optional background ingestion queue. When REDIS_URL is configured, source
 * (re)ingestion is enqueued to BullMQ and processed by a worker, so the HTTP
 * request that created/reprocessed the source returns immediately (the source
 * stays 'pending'/'processing'). Without Redis, `isEnabled()` is false and the
 * caller runs ingestion inline (bounded by a timeout) — so dev/test without
 * Redis keep working synchronously and need no changes.
 *
 * The worker body is identical to CrawlService's (job -> ingestSource), and the
 * stale-processing reaper recovers any job whose process dies mid-run.
 */
@Injectable()
export class IngestionQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IngestionQueueService.name);
  private queue?: Queue<IngestJob>;
  private worker?: Worker<IngestJob>;

  constructor(
    private readonly ingestion: IngestionService,
    @Optional() @Inject(APP_CONFIG) private readonly cfg?: AppConfig,
  ) {}

  onModuleInit(): void {
    if (this.cfg?.redisUrl) this.start(this.cfg.redisUrl);
  }

  /** Starts the queue + worker against a Redis URL. Idempotent-ish; used by DI
   * (onModuleInit) and directly by tests. */
  start(redisUrl: string): void {
    if (this.queue) return;
    const u = new URL(redisUrl);
    const connection = { host: u.hostname, port: Number(u.port) || 6379 };
    this.queue = new Queue<IngestJob>(QUEUE, { connection });
    this.worker = new Worker<IngestJob>(
      QUEUE,
      async (job) => {
        await this.ingestion.ingestSource(
          job.data.schemaName,
          job.data.sourceId,
        );
      },
      { connection },
    );
    this.worker.on('failed', (job, err) =>
      this.logger.warn(
        `Ingestion job ${job?.id ?? '?'} failed: ${err.message}`,
      ),
    );
  }

  /** True when a Redis-backed queue is active (async ingestion). */
  isEnabled(): boolean {
    return this.queue !== undefined;
  }

  /** Enqueues a source for background ingestion. Only valid when isEnabled(). */
  async enqueue(schemaName: string, sourceId: string): Promise<void> {
    if (!this.queue) throw new Error('Ingestion queue is not enabled');
    await this.queue.add(
      'ingest',
      { schemaName, sourceId },
      { removeOnComplete: true, removeOnFail: 100 },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
