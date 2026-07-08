import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';
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

@Module({
  imports: [
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
  ],
  controllers: [HealthController],
})
export class AppModule {}
