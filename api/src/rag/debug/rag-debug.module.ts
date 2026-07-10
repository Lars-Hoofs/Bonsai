import { Module } from '@nestjs/common';
import { TenancyModule } from '../../tenancy/tenancy.module';
import { SynonymsModule } from '../../synonyms/synonyms.module';
import { RagModule } from '../rag.module';
import { RagDebugController } from './rag-debug.controller';
import { RagDebugService } from './rag-debug.service';

@Module({
  imports: [TenancyModule, SynonymsModule, RagModule],
  controllers: [RagDebugController],
  providers: [RagDebugService],
})
export class RagDebugModule {}
