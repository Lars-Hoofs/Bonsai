import { ChunkingService } from './chunking.service';

describe('ChunkingService', () => {
  const svc = new ChunkingService();

  it('returns a single chunk for short text', () => {
    const chunks = svc.chunk('Korte tekst met een paar woorden.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].ordinal).toBe(0);
    expect(chunks[0].text).toContain('Korte tekst');
  });

  it('splits long text into multiple ordered chunks under the token budget', () => {
    const para = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
    const text = `${para}\n\n${para}\n\n${para}`;
    const chunks = svc.chunk(text, { maxTokens: 60, overlapTokens: 10 });
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c, i) => expect(c.ordinal).toBe(i));
    for (const c of chunks) expect(c.tokenCount).toBeLessThanOrEqual(60 + 10);
  });

  it('carries overlap between consecutive chunks', () => {
    const a = Array.from({ length: 40 }, (_, i) => `a${i}`).join(' ');
    const b = Array.from({ length: 40 }, (_, i) => `b${i}`).join(' ');
    const [first, second] = svc.chunk(`${a}\n\n${b}`, {
      maxTokens: 40,
      overlapTokens: 5,
    });
    const firstTail = first.text.split(/\s+/).slice(-5);
    expect(second.text.split(/\s+/).slice(0, 5)).toEqual(firstTail);
  });

  it('hard-splits a single oversized paragraph', () => {
    const huge = Array.from({ length: 150 }, (_, i) => `w${i}`).join(' ');
    const chunks = svc.chunk(huge, { maxTokens: 50, overlapTokens: 0 });
    expect(chunks.length).toBeGreaterThanOrEqual(3);
  });

  it('returns nothing for empty input', () => {
    expect(svc.chunk('   ')).toEqual([]);
  });
});
