import { cosine } from '../knowledge/ingestion/dedup';

export interface EmbeddedQuestion {
  id: string;
  question: string;
  embedding: number[];
}

export interface QuestionCluster {
  /** Representative question (the one closest to the cluster centroid). */
  label: string;
  /** How many unanswered questions fell into this cluster. */
  size: number;
  /** Ids of the member unanswered-question rows. */
  questionIds: string[];
  /** The distinct member question texts (deduped, capped for display). */
  examples: string[];
}

/**
 * Greedy single-pass agglomerative clustering over question embeddings using
 * cosine similarity — the self-hosted alternative to a hosted clustering
 * service. It reuses the same embedding layer and cosine utility as retrieval,
 * so no new model/infra is introduced.
 *
 * Algorithm: walk the questions (newest-first order is preserved by the
 * caller); for each, attach it to the first existing cluster whose centroid it
 * is within `threshold` cosine similarity of, otherwise start a new cluster.
 * Centroids are maintained as the running mean of member embeddings. This is
 * O(n * k) (n questions, k clusters) — fine for the volumes an editor review
 * screen deals with, and deterministic for a given input order.
 *
 * The result is sorted by cluster size descending (biggest KB gaps first),
 * then alphabetically by label for stable ordering of equal-sized clusters.
 */
export function clusterQuestions(
  questions: EmbeddedQuestion[],
  threshold: number,
  maxExamples = 5,
): QuestionCluster[] {
  interface WorkingCluster {
    centroid: number[];
    members: EmbeddedQuestion[];
  }
  const clusters: WorkingCluster[] = [];

  for (const q of questions) {
    if (q.embedding.length === 0) continue;
    let best: WorkingCluster | undefined;
    let bestSim = threshold;
    for (const c of clusters) {
      const sim = cosine(q.embedding, c.centroid);
      if (sim >= bestSim) {
        best = c;
        bestSim = sim;
      }
    }
    if (best) {
      best.members.push(q);
      best.centroid = updateCentroid(
        best.centroid,
        best.members.length,
        q.embedding,
      );
    } else {
      clusters.push({ centroid: [...q.embedding], members: [q] });
    }
  }

  return clusters
    .map((c) => toCluster(c.centroid, c.members, maxExamples))
    .sort((a, b) => b.size - a.size || a.label.localeCompare(b.label));
}

/** Running mean update: centroid becomes the mean of all `count` members. */
function updateCentroid(
  centroid: number[],
  count: number,
  next: number[],
): number[] {
  const out = centroid.slice();
  for (let i = 0; i < out.length; i++) {
    out[i] = out[i] + (next[i] - out[i]) / count;
  }
  return out;
}

function toCluster(
  centroid: number[],
  members: EmbeddedQuestion[],
  maxExamples: number,
): QuestionCluster {
  // Label = member closest to the centroid (most representative question).
  let label = members[0].question;
  let bestSim = -Infinity;
  for (const m of members) {
    const sim = cosine(m.embedding, centroid);
    if (sim > bestSim) {
      bestSim = sim;
      label = m.question;
    }
  }
  const examples: string[] = [];
  const seen = new Set<string>();
  for (const m of members) {
    const key = m.question.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    examples.push(m.question);
    if (examples.length >= maxExamples) break;
  }
  return {
    label,
    size: members.length,
    questionIds: members.map((m) => m.id),
    examples,
  };
}
