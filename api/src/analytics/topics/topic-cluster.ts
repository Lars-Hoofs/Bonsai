/**
 * Embedding-based topic clustering (#42).
 *
 * Groups the long tail of visitor questions the fixed intent ruleset can't
 * name (see intent-rules.ts) into emergent topics, using the existing
 * self-hosted embedding layer (EMBEDDING_PROVIDER) — no paid API.
 *
 * Algorithm: single-pass greedy agglomeration ("leader" clustering). Walk the
 * questions once; assign each to the first existing cluster whose centroid is
 * within COS_SIMILARITY_THRESHOLD (cosine), otherwise start a new cluster.
 * Centroids are maintained as running means and re-normalised. This is O(n*k)
 * (n questions, k clusters), needs no k up front, and is stable/deterministic
 * for a fixed input order — well suited to an on-read analytics endpoint over
 * a bounded time window.
 *
 * Cluster labels are derived cheaply from the members' own words: the most
 * frequent content token across the cluster (minus stopwords), which reads as
 * a recognisable topic keyword without another model call.
 */

import { NL_STOPWORDS, EN_STOPWORDS } from './stopwords';

export interface ClusterInput {
  /** Stable id for the question (e.g. conversation id) — passed through. */
  id: string;
  text: string;
  vector: number[];
}

export interface TopicCluster {
  /** 1-based cluster ordinal, most-frequent first. */
  ordinal: number;
  label: string;
  size: number;
  /** Representative example questions (bounded, truncated by the caller). */
  examples: string[];
  memberIds: string[];
}

// Cosine similarity above which a question joins an existing cluster. Tuned
// for short support questions: high enough to keep topics coherent, low
// enough that paraphrases group together. Kept as a module constant (not
// config) to avoid widening the deployment surface for this on-read feature.
export const COS_SIMILARITY_THRESHOLD = 0.82;

const MAX_EXAMPLES_PER_CLUSTER = 3;
const WORD_RE = /[\p{L}\p{N}]+/gu;

function dot(a: number[], b: number[]): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

function norm(a: number[]): number {
  return Math.sqrt(dot(a, a));
}

/** Cosine similarity, safe against zero-length vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  const na = norm(a);
  const nb = norm(b);
  if (na === 0 || nb === 0) return 0;
  return dot(a, b) / (na * nb);
}

interface MutableCluster {
  /** Sum of member vectors (centroid = sum / size, compared via cosine). */
  centroidSum: number[];
  members: ClusterInput[];
}

/**
 * Derive a short human label for a cluster from its members' most frequent
 * non-stopword token; falls back to the first example's leading words when no
 * content token stands out.
 */
function deriveLabel(members: ClusterInput[]): string {
  const counts = new Map<string, number>();
  for (const m of members) {
    const seen = new Set<string>();
    for (const raw of m.text.toLowerCase().match(WORD_RE) ?? []) {
      if (raw.length < 3) continue;
      if (NL_STOPWORDS.has(raw) || EN_STOPWORDS.has(raw)) continue;
      if (seen.has(raw)) continue; // count each token once per question
      seen.add(raw);
      counts.set(raw, (counts.get(raw) ?? 0) + 1);
    }
  }

  let bestWord = '';
  let bestCount = 0;
  for (const [word, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      bestWord = word;
    }
  }

  // Require the winning word to appear in at least two members (or in the only
  // member) to be a meaningful label; otherwise summarise the first example.
  if (bestWord && (members.length === 1 || bestCount >= 2)) {
    return bestWord;
  }
  const first = members[0]?.text.trim() ?? '';
  const words = first.split(/\s+/).slice(0, 4).join(' ');
  return words || 'overig';
}

/**
 * Cluster the inputs. Returns clusters sorted by size (desc), then by first
 * appearance for a stable, deterministic order.
 */
export function clusterQuestions(
  inputs: ClusterInput[],
  threshold: number = COS_SIMILARITY_THRESHOLD,
): TopicCluster[] {
  const clusters: MutableCluster[] = [];

  for (const input of inputs) {
    let bestIdx = -1;
    let bestSim = threshold;
    for (let i = 0; i < clusters.length; i++) {
      const sim = cosineSimilarity(input.vector, clusters[i].centroidSum);
      if (sim >= bestSim) {
        bestSim = sim;
        bestIdx = i;
      }
    }

    if (bestIdx === -1) {
      clusters.push({
        centroidSum: [...input.vector],
        members: [input],
      });
    } else {
      const c = clusters[bestIdx];
      const len = Math.min(c.centroidSum.length, input.vector.length);
      for (let i = 0; i < len; i++) c.centroidSum[i] += input.vector[i];
      c.members.push(input);
    }
  }

  return clusters
    .map((c, firstSeen) => ({ c, firstSeen }))
    .sort(
      (a, b) =>
        b.c.members.length - a.c.members.length || a.firstSeen - b.firstSeen,
    )
    .map(({ c }, idx) => ({
      ordinal: idx + 1,
      label: deriveLabel(c.members),
      size: c.members.length,
      examples: c.members.slice(0, MAX_EXAMPLES_PER_CLUSTER).map((m) => m.text),
      memberIds: c.members.map((m) => m.id),
    }));
}
