import { Module } from '@nestjs/common';
import { TenancyModule } from '../tenancy/tenancy.module';
import { UnansweredQuestionsController } from './unanswered-questions.controller';
import { UnansweredQuestionsService } from './unanswered-questions.service';

@Module({
  imports: [TenancyModule],
  controllers: [UnansweredQuestionsController],
  providers: [UnansweredQuestionsService],
  exports: [UnansweredQuestionsService],
})
export class UnansweredQuestionsModule {}
