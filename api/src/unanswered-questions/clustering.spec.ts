import { clusterQuestions } from './clustering';
import type { EmbeddedQuestion } from './clustering';

/**
 * Builds a tiny 2-D-ish embedding from a direction so tests can control
 * cosine similarity precisely. Vectors pointing the same way cluster.
 */
function vec(x: number, y: number): number[] {
  return [x, y];
}

describe('clusterQuestions', () => {
  it('groups similar questions and separates dissimilar ones', () => {
    const questions: EmbeddedQuestion[] = [
      { id: 'a', question: 'how do I reset my password', embedding: vec(1, 0) },
      { id: 'b', question: 'password reset help', embedding: vec(0.99, 0.01) },
      {
        id: 'c',
        question: 'what are your opening hours',
        embedding: vec(0, 1),
      },
    ];

    const clusters = clusterQuestions(questions, 0.9);

    expect(clusters).toHaveLength(2);
    // Biggest cluster first: the two password questions.
    expect(clusters[0].size).toBe(2);
    expect(clusters[0].questionIds.sort()).toEqual(['a', 'b']);
    expect(clusters[1].size).toBe(1);
    expect(clusters[1].questionIds).toEqual(['c']);
  });

  it('sorts by size desc then label asc for stable ordering', () => {
    const questions: EmbeddedQuestion[] = [
      { id: '1', question: 'zebra topic', embedding: vec(1, 0) },
      { id: '2', question: 'apple topic', embedding: vec(0, 1) },
    ];
    const clusters = clusterQuestions(questions, 0.99);
    // Two size-1 clusters -> alphabetical by label.
    expect(clusters.map((c) => c.label)).toEqual([
      'apple topic',
      'zebra topic',
    ]);
  });

  it('picks the member closest to the centroid as the label', () => {
    const questions: EmbeddedQuestion[] = [
      { id: 'a', question: 'outlier', embedding: vec(1, 0.4) },
      { id: 'b', question: 'central-1', embedding: vec(1, 0) },
      { id: 'c', question: 'central-2', embedding: vec(1, 0.01) },
    ];
    const clusters = clusterQuestions(questions, 0.8);
    expect(clusters).toHaveLength(1);
    // Centroid sits near the two central vectors, so the label is one of them.
    expect(['central-1', 'central-2']).toContain(clusters[0].label);
  });

  it('dedups example texts and caps them at maxExamples', () => {
    const questions: EmbeddedQuestion[] = [
      { id: 'a', question: 'same q', embedding: vec(1, 0) },
      { id: 'b', question: 'Same Q', embedding: vec(1, 0) },
      { id: 'c', question: 'other q', embedding: vec(1, 0) },
      { id: 'd', question: 'third q', embedding: vec(1, 0) },
    ];
    const clusters = clusterQuestions(questions, 0.5, 2);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].size).toBe(4);
    // 'same q' and 'Same Q' collapse to one example; capped at 2.
    expect(clusters[0].examples).toHaveLength(2);
    expect(clusters[0].examples[0]).toBe('same q');
  });

  it('skips questions with empty embeddings', () => {
    const questions: EmbeddedQuestion[] = [
      { id: 'a', question: 'valid', embedding: vec(1, 0) },
      { id: 'b', question: 'empty', embedding: [] },
    ];
    const clusters = clusterQuestions(questions, 0.5);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].questionIds).toEqual(['a']);
  });

  it('returns an empty array for no input', () => {
    expect(clusterQuestions([], 0.6)).toEqual([]);
  });
});
