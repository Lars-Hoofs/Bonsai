import { Module } from '@nestjs/common';
import { TenancyModule } from '../tenancy/tenancy.module';
import { KbBulkService } from './bulk/kb-bulk.service';
import { ChunkingService } from './chunking/chunking.service';
import { EmbeddingModule } from './embedding/embedding.module';
import { IngestionService } from './ingestion/ingestion.service';
import { IngestionQueueService } from './ingestion/ingestion-queue.service';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeSourcesService } from './knowledge-sources.service';

@Module({
  imports: [TenancyModule, EmbeddingModule],
  controllers: [KnowledgeController],
  providers: [
    ChunkingService,
    IngestionService,
    IngestionQueueService,
    KnowledgeSourcesService,
    KbBulkService,
  ],
  exports: [KnowledgeSourcesService, IngestionService],
})
export class KnowledgeModule {}
