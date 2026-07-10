import { Module } from '@nestjs/common';
import { TenancyModule } from '../tenancy/tenancy.module';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { TopicsController } from './topics/topics.controller';
import { TopicsService } from './topics/topics.service';

@Module({
  imports: [TenancyModule],
  controllers: [AnalyticsController, TopicsController],
  providers: [AnalyticsService, TopicsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
