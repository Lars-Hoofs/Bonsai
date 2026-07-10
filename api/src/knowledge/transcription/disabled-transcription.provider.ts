import { TranscriptionProvider } from './transcription-provider';

/**
 * Fallback provider used when Whisper is not configured (WHISPER_ENABLED
 * unset/false, or no endpoint) and in tests. Reports itself as disabled and
 * throws if called, so an audio/video upload fails with a clear message
 * instead of silently indexing an empty transcript.
 */
export class DisabledTranscriptionProvider implements TranscriptionProvider {
  readonly enabled = false;

  transcribe(): Promise<string> {
    return Promise.reject(
      new Error(
        'Audio/video transcription is not enabled on this deployment ' +
          '(set WHISPER_ENABLED=true and WHISPER_ENDPOINT).',
      ),
    );
  }
}
