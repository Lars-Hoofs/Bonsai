/**
 * Port for turning text into embedding vectors. The concrete provider calls an
 * external AI API (everything else is self-hosted on the VPS); tests use a
 * deterministic in-process fake so ingestion/retrieval run offline.
 */
export interface EmbeddingProvider {
  /** Embedding dimension; must match the pgvector column dimension. */
  readonly dimension: number;
  /** Embed a batch of texts, returning one vector per input, in order. */
  embed(texts: string[]): Promise<number[][]>;
}

export const EMBEDDING_PROVIDER = Symbol('EMBEDDING_PROVIDER');
