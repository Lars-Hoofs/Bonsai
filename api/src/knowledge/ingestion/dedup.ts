/**
 * Near-duplicate chunk detection for ingestion (#16).
 *
 * Two kinds of redundant chunks are dropped before insertion:
 *  - EXACT duplicates: identical text after whitespace/case normalization
 *    (e.g. nav/footer boilerplate repeated verbatim across crawled pages).
 *  - NEAR duplicates: embedding cosine similarity >= a threshold against any
 *    chunk already kept in the same run (paraphrased/near-identical content).
 *
 * A `Deduper` accumulates KEPT items across an entire source ingestion (all
 * documents), so boilerplate repeated *across* documents is caught too, not
 * just within a single document. Create a fresh instance per source
 * ingestion run.
 */

/** Trims, collapses runs of internal whitespace to a single space, and
 * lowercases — so "Footer  Text" and "footer text" compare equal. */
export function normalizeForDedup(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Cosine similarity between two equal-length vectors. Returns 0 (not NaN)
 * when either vector has zero magnitude, so callers never see NaN leak into
 * a `>= threshold` comparison. */
export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface Deduper {
  /**
   * Decides whether to keep `text`/`embedding`. Returns `false` (drop) if:
   *  - the normalized text exactly matches an already-kept item, or
   *  - cosine(embedding, kept) >= threshold for any already-kept item.
   * Otherwise records the item as kept and returns `true`.
   *
   * O(kept) per call — fine at expected per-source chunk counts.
   */
  shouldKeep(text: string, embedding: number[], threshold: number): boolean;
}

/** Creates a fresh Deduper with no memory of prior calls/instances. Scope
 * one per source-ingestion run. */
export function createDeduper(): Deduper {
  const keptNormalizedTexts = new Set<string>();
  const keptEmbeddings: number[][] = [];

  return {
    shouldKeep(text: string, embedding: number[], threshold: number): boolean {
      const normalized = normalizeForDedup(text);
      if (keptNormalizedTexts.has(normalized)) return false;

      for (const kept of keptEmbeddings) {
        if (cosine(embedding, kept) >= threshold) return false;
      }

      keptNormalizedTexts.add(normalized);
      keptEmbeddings.push(embedding);
      return true;
    },
  };
}
