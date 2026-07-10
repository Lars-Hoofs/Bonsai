import { Module } from '@nestjs/common';
import { TenancyModule } from '../../tenancy/tenancy.module';
import { RagModule } from '../rag.module';
import { EvalController } from './eval.controller';
import { EvalService } from './eval.service';

@Module({
  imports: [TenancyModule, RagModule],
  controllers: [EvalController],
  providers: [EvalService],
})
export class EvalModule {}
