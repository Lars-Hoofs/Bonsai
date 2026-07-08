/**
 * Port for a cross-encoder-style reranker: given a query and candidate
 * documents, returns a relevance score per document (higher = more relevant).
 * A real provider calls an external rerank API; tests use a deterministic
 * lexical fake; the no-op preserves the incoming order.
 */
export interface RerankProvider {
  rerank(query: string, documents: string[]): Promise<number[]>;
}

export const RERANK_PROVIDER = Symbol('RERANK_PROVIDER');

/** Preserves incoming order (all-equal scores). Default when no reranker configured. */
export class NoopRerankProvider implements RerankProvider {
  rerank(_query: string, documents: string[]): Promise<number[]> {
    return Promise.resolve(documents.map(() => 0));
  }
}

/** Deterministic lexical-overlap reranker for tests/dev (no network). */
export class FakeRerankProvider implements RerankProvider {
  rerank(query: string, documents: string[]): Promise<number[]> {
    const qTokens = new Set(tokens(query));
    if (qTokens.size === 0) return Promise.resolve(documents.map(() => 0));
    return Promise.resolve(
      documents.map((doc) => {
        const dTokens = new Set(tokens(doc));
        let hits = 0;
        for (const t of qTokens) if (dTokens.has(t)) hits++;
        return hits / qTokens.size;
      }),
    );
  }
}

function tokens(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}
