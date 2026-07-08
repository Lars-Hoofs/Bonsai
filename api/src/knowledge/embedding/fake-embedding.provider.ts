import { createHash } from 'node:crypto';
import { EmbeddingProvider } from './embedding-provider';

/**
 * Deterministic, offline embedding provider for tests and local dev.
 *
 * Uses a hashing bag-of-words projection: each lowercased token increments a
 * bucket (token hash mod dimension); the vector is then L2-normalised. Texts
 * that share words get higher cosine similarity, so retrieval behaviour is
 * meaningful in tests — without any network call.
 */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  constructor(readonly dimension: number = 1024) {}

  embed(texts: string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((t) => this.embedOne(t)));
  }

  private embedOne(text: string): number[] {
    const vec = new Array<number>(this.dimension).fill(0);
    const tokens = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    for (const token of tokens) {
      const h = createHash('sha256').update(token).digest();
      const bucket = h.readUInt32BE(0) % this.dimension;
      const sign = (h[4] & 1) === 0 ? 1 : -1;
      vec[bucket] += sign;
    }
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    if (norm === 0) {
      // Empty/word-less text: return a stable unit vector, not all-zeros,
      // so cosine distance is defined.
      vec[0] = 1;
      return vec;
    }
    return vec.map((v) => v / norm);
  }
}
