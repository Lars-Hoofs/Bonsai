import { Module } from '@nestjs/common';
import { TenancyModule } from '../tenancy/tenancy.module';
import { AnswerTemplatesController } from './answer-templates.controller';
import { AnswerTemplatesService } from './answer-templates.service';

@Module({
  imports: [TenancyModule],
  controllers: [AnswerTemplatesController],
  providers: [AnswerTemplatesService],
  exports: [AnswerTemplatesService],
})
export class AnswerTemplatesModule {}
