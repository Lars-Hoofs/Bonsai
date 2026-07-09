import { Global, Module } from '@nestjs/common';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

/**
 * Global so any service (AnswerService, ConversationsService,
 * IngestionService, RateLimitGuard, ...) can inject `MetricsService` without
 * every consuming module having to import MetricsModule explicitly — mirrors
 * the existing @Global() DbModule/UsageModule style in this codebase.
 */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
