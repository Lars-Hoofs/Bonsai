import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { HealthController } from './health/health.controller';
import { MetricsModule } from './metrics/metrics.module';
import { MetricsInterceptor } from './metrics/metrics.interceptor';
import { DbModule } from './db/db.module';
import { TenancyModule } from './tenancy/tenancy.module';
import { AuthModule } from './auth/auth.module';
import { AuditModule } from './audit/audit.module';
import { TenantsModule } from './tenants/tenants.module';
import { ProjectsModule } from './projects/projects.module';
import { ApiKeysModule } from './apikeys/apikeys.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { RagModule } from './rag/rag.module';
import { ConversationsModule } from './conversations/conversations.module';
import { WidgetModule } from './widget/widget.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { UsageModule } from './usage/usage.module';
import { CrawlModule } from './crawl/crawl.module';
import { StorageModule } from './storage/storage.module';

@Module({
  imports: [
    EventEmitterModule.forRoot(),
    MetricsModule,
    DbModule,
    TenancyModule,
    AuthModule,
    AuditModule,
    TenantsModule,
    ProjectsModule,
    ApiKeysModule,
    KnowledgeModule,
    RagModule,
    ConversationsModule,
    WidgetModule,
    AnalyticsModule,
    WebhooksModule,
    UsageModule,
    CrawlModule,
    StorageModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: MetricsInterceptor }],
})
export class AppModule {}
