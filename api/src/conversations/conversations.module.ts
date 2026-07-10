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
import { RagModule } from '../rag/rag.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { WebhooksService } from '../webhooks/webhooks.service';
import { ApiKeysModule } from '../apikeys/apikeys.module';
import { PresenceModule } from '../presence/presence.module';
import { MetricsService } from '../metrics/metrics.service';
import {
  AgentPresenceController,
  ConversationsController,
} from './conversations.controller';
import { ConversationsPublicController } from './conversations-public.controller';
import { ConversationsService } from './conversations.service';
import { ConversationReaperService } from './conversation-reaper.service';
import { ChatGateway } from './chat.gateway';
import { PublicWidgetGuard } from './public-widget.guard';

/**
 * Starts the idle-conversation auto-close reaper (#40) on a plain in-process
 * interval when `AUTO_CLOSE_ENABLED` is set. No Redis dependency: auto-close
 * must work in the base self-hosted deployment. Per-project opt-in + threshold
 * are read from `projects.settings` inside each sweep.
 */
@Injectable()
class ConversationReaperBootstrap implements OnModuleInit, OnModuleDestroy {
  private reaper?: ConversationReaperService;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly tenantDb: TenantDbService,
    private readonly webhooks: WebhooksService,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    if (!this.cfg.autoCloseEnabled) return;
    this.reaper = new ConversationReaperService(
      this.pool,
      this.tenantDb,
      this.webhooks,
      this.metrics,
      this.cfg.autoCloseDefaultIdleMinutes,
    );
    this.reaper.start(this.cfg.autoCloseSweepIntervalMs);
  }

  onModuleDestroy(): void {
    this.reaper?.stop();
  }
}

@Module({
  imports: [
    TenancyModule,
    RagModule,
    WebhooksModule,
    ApiKeysModule,
    PresenceModule,
  ],
  controllers: [
    ConversationsController,
    ConversationsPublicController,
    AgentPresenceController,
  ],
  providers: [
    ConversationsService,
    ChatGateway,
    PublicWidgetGuard,
    ConversationReaperBootstrap,
  ],
})
export class ConversationsModule {}
