import {
  clusterQuestions,
  cosineSimilarity,
  ClusterInput,
} from './topic-cluster';

// Deterministic 2D unit vectors for clustering assertions. The real service
// uses the embedding provider; here we hand-craft vectors so the grouping is
// unambiguous.
function vec(x: number, y: number): number[] {
  const n = Math.hypot(x, y) || 1;
  return [x / n, y / n];
}

describe('cosineSimilarity', () => {
  it('is 1 for identical direction and 0 for orthogonal', () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1, 5);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
  });

  it('is 0 for a zero vector (safe)', () => {
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
  });
});

describe('clusterQuestions', () => {
  it('groups near-parallel vectors and separates distant ones', () => {
    const inputs: ClusterInput[] = [
      { id: 'a', text: 'retour sturen pakket', vector: vec(1, 0.02) },
      { id: 'b', text: 'retour aanvragen pakket', vector: vec(1, 0.05) },
      { id: 'c', text: 'openingstijden winkel zaterdag', vector: vec(0.02, 1) },
    ];
    const clusters = clusterQuestions(inputs, 0.9);
    expect(clusters).toHaveLength(2);
    // Largest cluster first.
    expect(clusters[0].size).toBe(2);
    expect(clusters[0].memberIds.sort()).toEqual(['a', 'b']);
    expect(clusters[1].size).toBe(1);
    expect(clusters[1].memberIds).toEqual(['c']);
  });

  it('labels a cluster from its most frequent content word', () => {
    const inputs: ClusterInput[] = [
      { id: 'a', text: 'retour pakket sturen', vector: vec(1, 0) },
      { id: 'b', text: 'retour pakket aanvragen', vector: vec(1, 0.01) },
    ];
    const [cluster] = clusterQuestions(inputs, 0.9);
    // "retour" and "pakket" both appear twice; label is a content word, never
    // a stopword.
    expect(['retour', 'pakket']).toContain(cluster.label);
  });

  it('is deterministic and ordinals are 1-based', () => {
    const inputs: ClusterInput[] = [
      { id: 'x', text: 'een twee drie', vector: vec(1, 0) },
    ];
    const clusters = clusterQuestions(inputs);
    expect(clusters[0].ordinal).toBe(1);
    expect(clusters[0].examples).toEqual(['een twee drie']);
  });
});
