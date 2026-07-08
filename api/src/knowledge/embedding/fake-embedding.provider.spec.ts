import { FakeEmbeddingProvider } from './fake-embedding.provider';

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // inputs are unit vectors
}

describe('FakeEmbeddingProvider', () => {
  const provider = new FakeEmbeddingProvider(256);

  it('returns one unit vector per input of the configured dimension', async () => {
    const [v] = await provider.embed(['hello world']);
    expect(v).toHaveLength(256);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it('is deterministic', async () => {
    const [a] = await provider.embed(['same text']);
    const [b] = await provider.embed(['same text']);
    expect(a).toEqual(b);
  });

  it('gives higher similarity to texts that share words', async () => {
    const [q, near, far] = await provider.embed([
      'openingstijden van de winkel',
      'wat zijn de openingstijden van de winkel vandaag',
      'retourneren van een defect product',
    ]);
    expect(cosine(q, near)).toBeGreaterThan(cosine(q, far));
  });

  it('handles empty text without producing NaN', async () => {
    const [v] = await provider.embed(['']);
    expect(v.every((x) => Number.isFinite(x))).toBe(true);
  });
});
