import { Module } from '@nestjs/common';
import { TenancyModule } from '../tenancy/tenancy.module';
import { CannedResponsesController } from './canned-responses.controller';
import { CannedResponsesService } from './canned-responses.service';

@Module({
  imports: [TenancyModule],
  controllers: [CannedResponsesController],
  providers: [CannedResponsesService],
  exports: [CannedResponsesService],
})
export class CannedResponsesModule {}
