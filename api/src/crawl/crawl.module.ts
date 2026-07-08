import {
  Inject,
  Injectable,
  Module,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Pool } from 'pg';
import { APP_CONFIG } from '../config/config';
import type { AppConfig } from '../config/config';
import { PG_POOL } from '../db/db.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { TenantDbService } from '../tenancy/tenant-db.service';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { IngestionService } from '../knowledge/ingestion/ingestion.service';
import { CrawlService } from './crawl.service';

/**
 * Starts the re-crawl queue/worker + repeatable scan only when REDIS_URL is
 * configured; otherwise scheduled re-crawl is simply disabled (on-demand
 * reprocess still works), so the app runs fine without Redis.
 */
@Injectable()
class CrawlBootstrap implements OnModuleInit, OnModuleDestroy {
  private service?: CrawlService;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly tenantDb: TenantDbService,
    private readonly ingestion: IngestionService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.cfg.redisUrl) return;
    this.service = new CrawlService(
      this.cfg.redisUrl,
      this.pool,
      this.tenantDb,
      this.ingestion,
    );
    this.service.start();
    await this.service.scheduleRecurring(this.cfg.recrawlIntervalMs);
  }

  async onModuleDestroy(): Promise<void> {
    await this.service?.close();
  }
}

@Module({
  imports: [TenancyModule, KnowledgeModule],
  providers: [CrawlBootstrap],
})
export class CrawlModule {}
