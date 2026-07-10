import { Module } from '@nestjs/common';
import { TenancyModule } from '../tenancy/tenancy.module';
import { ModerationController } from './moderation.controller';
import { ModerationService } from './moderation.service';

@Module({
  imports: [TenancyModule],
  controllers: [ModerationController],
  providers: [ModerationService],
  exports: [ModerationService],
})
export class ModerationModule {}
