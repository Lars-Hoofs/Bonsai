import { cosine, createDeduper, normalizeForDedup } from './dedup';

describe('normalizeForDedup', () => {
  it('trims leading/trailing whitespace', () => {
    expect(normalizeForDedup('  hello world  ')).toBe('hello world');
  });

  it('collapses internal whitespace runs to a single space', () => {
    expect(normalizeForDedup('hello   \n\t  world')).toBe('hello world');
  });

  it('lowercases the text', () => {
    expect(normalizeForDedup('Hello WORLD')).toBe('hello world');
  });

  it('treats case/whitespace-different text as identical after normalization', () => {
    expect(normalizeForDedup('  Hello   World  ')).toBe(
      normalizeForDedup('hello world'),
    );
  });
});

describe('cosine', () => {
  it('returns 1 for identical unit vectors', () => {
    expect(cosine([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 10);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosine([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 10);
  });

  it('returns -1 for opposite vectors', () => {
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
  });

  it('handles non-unit vectors correctly', () => {
    expect(cosine([2, 0], [3, 0])).toBeCloseTo(1, 10);
  });

  it('returns 0 when either vector is all-zero (defined, non-NaN)', () => {
    expect(cosine([0, 0], [1, 1])).toBe(0);
    expect(cosine([0, 0], [0, 0])).toBe(0);
  });
});

describe('Deduper', () => {
  it('keeps the first distinct chunk', () => {
    const deduper = createDeduper();
    expect(deduper.shouldKeep('unique text one', [1, 0, 0], 0.97)).toBe(true);
  });

  it('drops an exact duplicate of an already-kept chunk (same normalized text)', () => {
    const deduper = createDeduper();
    expect(deduper.shouldKeep('Footer text here', [1, 0, 0], 0.97)).toBe(true);
    // Different embedding vector on purpose: the exact-text rule must fire
    // independently of embedding similarity.
    expect(deduper.shouldKeep('Footer text here', [0, 1, 0], 0.97)).toBe(false);
  });

  it('treats case/whitespace-different but identical text as an exact duplicate', () => {
    const deduper = createDeduper();
    expect(deduper.shouldKeep('  Footer   Text  ', [1, 0, 0], 0.97)).toBe(true);
    expect(deduper.shouldKeep('footer text', [0, 1, 0], 0.97)).toBe(false);
  });

  it('drops a near-duplicate whose cosine similarity to a kept item >= threshold', () => {
    const deduper = createDeduper();
    expect(deduper.shouldKeep('some kept chunk', [1, 0, 0], 0.97)).toBe(true);
    // cosine([1,0,0], [0.99, sqrt(1-0.99^2), 0]) == 0.99 >= 0.97 threshold.
    const nearVec = [0.99, Math.sqrt(1 - 0.99 * 0.99), 0];
    expect(deduper.shouldKeep('totally different wording', nearVec, 0.97)).toBe(
      false,
    );
  });

  it('keeps a distinct chunk whose cosine similarity is below threshold', () => {
    const deduper = createDeduper();
    expect(deduper.shouldKeep('some kept chunk', [1, 0, 0], 0.97)).toBe(true);
    expect(
      deduper.shouldKeep('a genuinely different chunk', [0, 1, 0], 0.97),
    ).toBe(true);
  });

  it('accumulates multiple kept items and checks new items against all of them', () => {
    const deduper = createDeduper();
    expect(deduper.shouldKeep('chunk a', [1, 0, 0], 0.97)).toBe(true);
    expect(deduper.shouldKeep('chunk b', [0, 1, 0], 0.97)).toBe(true);
    // Near-dup of the second kept vector, not the first.
    const nearB = [Math.sqrt(1 - 0.99 * 0.99), 0.99, 0];
    expect(deduper.shouldKeep('chunk c', nearB, 0.97)).toBe(false);
  });

  it('is scoped per instance (a fresh Deduper has no memory of a previous one)', () => {
    const first = createDeduper();
    expect(first.shouldKeep('repeated footer', [1, 0, 0], 0.97)).toBe(true);

    const second = createDeduper();
    expect(second.shouldKeep('repeated footer', [1, 0, 0], 0.97)).toBe(true);
  });
});
