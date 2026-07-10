import { Global, Module } from '@nestjs/common';
import { APP_CONFIG } from '../../config/config';
import type { AppConfig } from '../../config/config';
import { DisabledTranscriptionProvider } from './disabled-transcription.provider';
import { TRANSCRIPTION_PROVIDER } from './transcription-provider';
import type { TranscriptionProvider } from './transcription-provider';
import { WhisperTranscriptionProvider } from './whisper-transcription.provider';

/**
 * Provides the TranscriptionProvider. When WHISPER_ENABLED is true and
 * WHISPER_ENDPOINT is set, the real self-hosted Whisper HTTP provider is used;
 * otherwise (tests, dev, opted-out deployments) a disabled stub is used that
 * rejects audio/video uploads with a clear error. Same injectable-provider
 * seam as EmbeddingModule / the OCR provider, so tests can stub it.
 */
@Global()
@Module({
  providers: [
    {
      provide: TRANSCRIPTION_PROVIDER,
      useFactory: (cfg: AppConfig): TranscriptionProvider => {
        if (cfg.whisperEnabled && cfg.whisperEndpoint) {
          return new WhisperTranscriptionProvider({
            endpoint: cfg.whisperEndpoint,
            apiKey: cfg.whisperApiKey,
            model: cfg.whisperModel,
            timeoutMs: cfg.whisperTimeoutMs,
          });
        }
        return new DisabledTranscriptionProvider();
      },
      inject: [APP_CONFIG],
    },
  ],
  exports: [TRANSCRIPTION_PROVIDER],
})
export class TranscriptionModule {}
