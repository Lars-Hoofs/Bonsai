import { Module } from '@nestjs/common';
import { APP_CONFIG } from '../config/config';
import type { AppConfig } from '../config/config';
import { TenancyModule } from '../tenancy/tenancy.module';
import { EmbeddingModule } from '../knowledge/embedding/embedding.module';
import { RetrievalService } from './retrieval.service';
import { AnswerService } from './answer.service';
import { RagController } from './rag.controller';
import { LLM_PROVIDER } from './llm-provider';
import type { LlmProvider } from './llm-provider';
import { HttpLlmProvider } from './http-llm.provider';
import { FakeLlmProvider } from './fake-llm.provider';

@Module({
  imports: [TenancyModule, EmbeddingModule],
  controllers: [RagController],
  providers: [
    RetrievalService,
    AnswerService,
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
  ],
  exports: [RetrievalService, AnswerService],
})
export class RagModule {}
