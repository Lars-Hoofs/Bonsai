import { RerankProvider } from './rerank-provider';

/**
 * Calls an external, Cohere-style rerank API
 * (POST { model, query, documents } -> { results: [{ index, relevance_score }] }).
 * Endpoint/key/model are configuration.
 */
export class HttpRerankProvider implements RerankProvider {
  constructor(
    private readonly opts: { url: string; apiKey: string; model: string },
  ) {}

  async rerank(query: string, documents: string[]): Promise<number[]> {
    if (documents.length === 0) return [];
    const res = await fetch(this.opts.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify({ model: this.opts.model, query, documents }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `Rerank API error ${res.status}: ${detail.slice(0, 200)}`,
      );
    }
    const body = (await res.json()) as {
      results?: { index: number; relevance_score: number }[];
    };
    const scores = new Array<number>(documents.length).fill(0);
    for (const r of body.results ?? []) {
      if (r.index >= 0 && r.index < scores.length) {
        scores[r.index] = r.relevance_score;
      }
    }
    return scores;
  }
}
