import { Module } from '@nestjs/common';
import { AnalyticsModule } from '../analytics/analytics.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { ReportsRunnerService } from './reports-runner.service';

/**
 * Exportable reports (#45): on-demand CSV/JSON export + scheduled generation.
 * UsageService, MailService, StorageService and AuditService are all Global
 * providers, so only TenancyModule (tenant DB) and AnalyticsModule (analytics
 * aggregation, exported for reuse) need importing.
 */
@Module({
  imports: [TenancyModule, AnalyticsModule],
  controllers: [ReportsController],
  providers: [ReportsService, ReportsRunnerService],
  exports: [ReportsService],
})
export class ReportsModule {}
