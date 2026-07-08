import { EmbeddingProvider } from './embedding-provider';

/**
 * Calls an external, OpenAI-compatible embeddings API
 * (POST { model, input } -> { data: [{ embedding: number[] }] }).
 * Endpoint, key and model are configuration, so any EU-hosted or
 * DPA-covered provider can be plugged in without code changes.
 */
export class HttpEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private readonly opts: {
      url: string;
      apiKey: string;
      model: string;
      dimension: number;
    },
  ) {}

  get dimension(): number {
    return this.opts.dimension;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await fetch(this.opts.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.opts.apiKey}`,
      },
      // Request the exact output dimensionality. OpenAI-compatible embedding
      // APIs (incl. Google Gemini's, and OpenAI text-embedding-3) honour this;
      // required for Gemini's gemini-embedding-001 whose default (3072) would
      // otherwise not match the pgvector column / configured dimension.
      body: JSON.stringify({
        model: this.opts.model,
        input: texts,
        dimensions: this.opts.dimension,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `Embedding API error ${res.status}: ${detail.slice(0, 200)}`,
      );
    }
    const body = (await res.json()) as { data?: { embedding?: number[] }[] };
    const data = body.data;
    if (!Array.isArray(data) || data.length !== texts.length) {
      throw new Error('Embedding API returned an unexpected shape');
    }
    return data.map((d, i) => {
      const e = d.embedding;
      if (!Array.isArray(e) || e.length !== this.opts.dimension) {
        throw new Error(
          `Embedding ${i} has wrong dimension (expected ${this.opts.dimension})`,
        );
      }
      return e;
    });
  }
}
