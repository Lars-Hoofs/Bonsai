import { Global, Module } from '@nestjs/common';
import { APP_CONFIG } from '../../config/config';
import type { AppConfig } from '../../config/config';
import { EMBEDDING_PROVIDER } from './embedding-provider';
import type { EmbeddingProvider } from './embedding-provider';
import { FakeEmbeddingProvider } from './fake-embedding.provider';
import { HttpEmbeddingProvider } from './http-embedding.provider';

/**
 * Provides the EmbeddingProvider. When EMBEDDING_API_URL (+ key + model) is
 * configured, the real HTTP provider is used; otherwise (tests, local dev) the
 * deterministic fake is used so ingestion works offline.
 */
@Global()
@Module({
  providers: [
    {
      provide: EMBEDDING_PROVIDER,
      useFactory: (cfg: AppConfig): EmbeddingProvider => {
        if (cfg.embeddingApiUrl && cfg.embeddingApiKey && cfg.embeddingModel) {
          return new HttpEmbeddingProvider({
            url: cfg.embeddingApiUrl,
            apiKey: cfg.embeddingApiKey,
            model: cfg.embeddingModel,
            dimension: cfg.embeddingDim,
          });
        }
        return new FakeEmbeddingProvider(cfg.embeddingDim);
      },
      inject: [APP_CONFIG],
    },
  ],
  exports: [EMBEDDING_PROVIDER],
})
export class EmbeddingModule {}
