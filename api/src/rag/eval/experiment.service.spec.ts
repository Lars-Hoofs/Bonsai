import { pickBestVariantId } from './experiment.service';

describe('pickBestVariantId', () => {
  it('returns null for no variants', () => {
    expect(pickBestVariantId([])).toBeNull();
  });

  it('picks the single variant', () => {
    expect(pickBestVariantId([{ variantId: 'a', score: 0.5 }])).toBe('a');
  });

  it('picks the highest-scoring variant', () => {
    expect(
      pickBestVariantId([
        { variantId: 'a', score: 0.2 },
        { variantId: 'b', score: 0.9 },
        { variantId: 'c', score: 0.5 },
      ]),
    ).toBe('b');
  });

  it('breaks ties by run order (first max wins, deterministic)', () => {
    expect(
      pickBestVariantId([
        { variantId: 'a', score: 0.8 },
        { variantId: 'b', score: 0.8 },
      ]),
    ).toBe('a');
  });

  it('handles an all-zero (no cases passed) run', () => {
    expect(
      pickBestVariantId([
        { variantId: 'a', score: 0 },
        { variantId: 'b', score: 0 },
      ]),
    ).toBe('a');
  });
});
