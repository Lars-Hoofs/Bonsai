import { Global, Module } from '@nestjs/common';
import { UsageController } from './usage.controller';
import { UsageService } from './usage.service';
import { RateLimiterService } from './rate-limiter.service';
import { RateLimitGuard } from './rate-limit.guard';

@Global()
@Module({
  controllers: [UsageController],
  providers: [UsageService, RateLimiterService, RateLimitGuard],
  exports: [UsageService, RateLimiterService, RateLimitGuard],
})
export class UsageModule {}
