import { Module } from '@nestjs/common';
import { APP_CONFIG } from '../config/config';
import type { AppConfig } from '../config/config';
import { TenancyModule } from '../tenancy/tenancy.module';
import { KbBulkService } from './bulk/kb-bulk.service';
import { ArticlesController } from './articles.controller';
import { ArticlesService } from './articles.service';
import { ChunkingService } from './chunking/chunking.service';
import { EmbeddingModule } from './embedding/embedding.module';
import { IngestionService } from './ingestion/ingestion.service';
import { IngestionQueueService } from './ingestion/ingestion-queue.service';
import { OCR_PROVIDER } from './ingestion/ocr-provider';
import type { OcrProvider } from './ingestion/ocr-provider';
import { TesseractOcrProvider } from './ingestion/tesseract-ocr.provider';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeSourcesService } from './knowledge-sources.service';
import { TranscriptionModule } from './transcription/transcription.module';

@Module({
  imports: [TenancyModule, EmbeddingModule, TranscriptionModule],
  controllers: [KnowledgeController, ArticlesController],
  providers: [
    ChunkingService,
    IngestionService,
    IngestionQueueService,
    KnowledgeSourcesService,
    KbBulkService,
    // Self-hosted OCR fallback (#24) for scanned uploads. Always provides a
    // real TesseractOcrProvider (OCR_ENABLED just gates whether it's ever
    // *invoked* — see extractUploadText/KnowledgeController); tests override
    // this provider token with a stub so real OCR never runs in unit/e2e
    // tests.
    {
      provide: OCR_PROVIDER,
      useFactory: (cfg: AppConfig): OcrProvider =>
        new TesseractOcrProvider(cfg.ocrLanguages),
      inject: [APP_CONFIG],
    },
    ArticlesService,
  ],
  exports: [KnowledgeSourcesService, IngestionService, ArticlesService],
})
export class KnowledgeModule {}
