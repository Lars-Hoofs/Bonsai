import { Module } from '@nestjs/common';
import { APP_CONFIG } from '../config/config';
import type { AppConfig } from '../config/config';
import { TenancyModule } from '../tenancy/tenancy.module';
import { EmbeddingModule } from '../knowledge/embedding/embedding.module';
import { RetrievalService } from './retrieval.service';
import { AnswerService } from './answer.service';
import { AnswerCacheService } from './answer-cache.service';
import { RagController } from './rag.controller';
import { LLM_PROVIDER } from './llm-provider';
import type { LlmProvider } from './llm-provider';
import { HttpLlmProvider } from './http-llm.provider';
import { FakeLlmProvider } from './fake-llm.provider';
import { FakeRerankProvider, RERANK_PROVIDER } from './rerank-provider';
import type { RerankProvider } from './rerank-provider';
import { HttpRerankProvider } from './http-rerank.provider';

@Module({
  imports: [TenancyModule, EmbeddingModule],
  controllers: [RagController],
  providers: [
    RetrievalService,
    AnswerService,
    AnswerCacheService,
    {
      provide: LLM_PROVIDER,
      useFactory: (cfg: AppConfig): LlmProvider => {
        if (cfg.llmApiUrl && cfg.llmApiKey && cfg.llmModel) {
          return new HttpLlmProvider({
            url: cfg.llmApiUrl,
            apiKey: cfg.llmApiKey,
            model: cfg.llmModel,
          });
        }
        return new FakeLlmProvider();
      },
      inject: [APP_CONFIG],
    },
    {
      provide: RERANK_PROVIDER,
      useFactory: (cfg: AppConfig): RerankProvider => {
        if (cfg.rerankApiUrl && cfg.rerankApiKey && cfg.rerankModel) {
          return new HttpRerankProvider({
            url: cfg.rerankApiUrl,
            apiKey: cfg.rerankApiKey,
            model: cfg.rerankModel,
          });
        }
        return new FakeRerankProvider();
      },
      inject: [APP_CONFIG],
    },
  ],
  exports: [RetrievalService, AnswerService],
})
export class RagModule {}
