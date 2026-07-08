import { Module } from '@nestjs/common';
import { TenancyModule } from '../tenancy/tenancy.module';
import { ChunkingService } from './chunking/chunking.service';
import { EmbeddingModule } from './embedding/embedding.module';
import { IngestionService } from './ingestion/ingestion.service';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeSourcesService } from './knowledge-sources.service';

@Module({
  imports: [TenancyModule, EmbeddingModule],
  controllers: [KnowledgeController],
  providers: [ChunkingService, IngestionService, KnowledgeSourcesService],
  exports: [KnowledgeSourcesService, IngestionService],
})
export class KnowledgeModule {}
