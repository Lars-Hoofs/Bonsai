import { TranscriptionProvider } from './transcription-provider';

/**
 * Calls a self-hosted, OpenAI-compatible Whisper HTTP service (e.g.
 * faster-whisper-server / whisper.cpp server / whisperX running as a Docker
 * sidecar on the VPS). Sends the media as multipart/form-data to the
 * transcriptions endpoint and reads back the plain-text transcript.
 *
 *   POST {endpoint}  (multipart: file, model)  ->  { text: string }
 *
 * Endpoint, optional bearer key and model are configuration, so any
 * self-hosted Whisper flavour can be plugged in without code changes.
 */
export class WhisperTranscriptionProvider implements TranscriptionProvider {
  readonly enabled = true;

  constructor(
    private readonly opts: {
      endpoint: string;
      apiKey?: string;
      model: string;
      timeoutMs: number;
    },
  ) {}

  async transcribe(
    file: Buffer,
    filename: string,
    mimetype: string,
  ): Promise<string> {
    const form = new FormData();
    // Wrap the buffer in a Blob so undici's fetch emits proper multipart
    // form-data with a filename part (Whisper servers key the decoder off it).
    const blob = new Blob([new Uint8Array(file)], {
      type: mimetype || 'application/octet-stream',
    });
    form.append('file', blob, filename || 'audio');
    form.append('model', this.opts.model);
    // Ask for JSON `{ text }` (the OpenAI-compatible default); the parser
    // below also tolerates a bare string or a plain-text body.
    form.append('response_format', 'json');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    let res: Response;
    try {
      res = await fetch(this.opts.endpoint, {
        method: 'POST',
        headers: this.opts.apiKey
          ? { authorization: `Bearer ${this.opts.apiKey}` }
          : undefined,
        body: form,
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(
          `Whisper transcription timed out after ${this.opts.timeoutMs}ms`,
        );
      }
      throw new Error(
        `Whisper transcription request failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `Whisper API error ${res.status}: ${detail.slice(0, 200)}`,
      );
    }

    // Response shapes vary by Whisper flavour: OpenAI-compatible servers
    // return JSON `{ text }`; some return a bare JSON string; `text`-format
    // servers return the transcript as plain text. Read the raw body and
    // handle all three.
    const body = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      // Not JSON — treat the whole body as the plain-text transcript.
      return body.trim();
    }
    const text =
      typeof parsed === 'string'
        ? parsed
        : parsed &&
            typeof parsed === 'object' &&
            typeof (parsed as { text?: unknown }).text === 'string'
          ? (parsed as { text: string }).text
          : null;
    if (text === null) {
      throw new Error('Whisper API returned an unexpected shape');
    }
    return text.trim();
  }
}
