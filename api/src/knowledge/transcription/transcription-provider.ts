/**
 * Port for turning an audio/video file into a plain-text transcript. The
 * concrete provider calls a self-hosted Whisper HTTP service (a Docker
 * sidecar); tests and unconfigured deployments use a disabled stub that
 * refuses so ingestion stays offline and deterministic.
 *
 * Mirrors the injectable-provider seam used by EmbeddingProvider (and the OCR
 * provider): a symbol DI token + a factory in the module that picks the real
 * HTTP implementation only when WHISPER_ENABLED and an endpoint are configured.
 */
export interface TranscriptionProvider {
  /** Whether transcription is actually available (Whisper configured). When
   * false, callers should reject audio/video uploads with a clear error
   * rather than silently indexing nothing. */
  readonly enabled: boolean;

  /**
   * Transcribe an audio/video file to plain text.
   * @param file    raw media bytes
   * @param filename original filename (helps the service pick a decoder)
   * @param mimetype the upload content type
   */
  transcribe(file: Buffer, filename: string, mimetype: string): Promise<string>;
}

export const TRANSCRIPTION_PROVIDER = Symbol('TRANSCRIPTION_PROVIDER');
