import { FakeRerankProvider, NoopRerankProvider } from './rerank-provider';

describe('FakeRerankProvider', () => {
  const rr = new FakeRerankProvider();

  it('scores documents by lexical overlap with the query', async () => {
    const scores = await rr.rerank('openingstijden winkel', [
      'de openingstijden van de winkel zijn negen tot vijf',
      'retourneren van een defect product',
    ]);
    expect(scores[0]).toBeGreaterThan(scores[1]);
  });

  it('returns one score per document and zero for an empty query', async () => {
    expect(await rr.rerank('', ['a', 'b'])).toEqual([0, 0]);
    expect(await rr.rerank('x', ['a', 'b', 'c'])).toHaveLength(3);
  });
});

describe('NoopRerankProvider', () => {
  it('scores everything equally (preserves incoming order)', async () => {
    const scores = await new NoopRerankProvider().rerank('q', ['a', 'b']);
    expect(scores).toEqual([0, 0]);
  });
});
