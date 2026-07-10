import { Module } from '@nestjs/common';
import { TenancyModule } from '../tenancy/tenancy.module';
import { ChunkingService } from './chunking/chunking.service';
import { EmbeddingModule } from './embedding/embedding.module';
import { IngestionService } from './ingestion/ingestion.service';
import { IngestionQueueService } from './ingestion/ingestion-queue.service';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeSourcesService } from './knowledge-sources.service';
import { TranscriptionModule } from './transcription/transcription.module';

@Module({
  imports: [TenancyModule, EmbeddingModule, TranscriptionModule],
  controllers: [KnowledgeController],
  providers: [
    ChunkingService,
    IngestionService,
    IngestionQueueService,
    KnowledgeSourcesService,
  ],
  exports: [KnowledgeSourcesService, IngestionService],
})
export class KnowledgeModule {}
