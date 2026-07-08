import { HttpEmbeddingProvider } from './http-embedding.provider';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('HttpEmbeddingProvider', () => {
  const opts = {
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/embeddings',
    apiKey: 'test-key',
    model: 'gemini-embedding-001',
    dimension: 1024,
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('requests the configured dimensionality and returns the embeddings', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        jsonResponse({ data: [{ embedding: Array<number>(1024).fill(0.01) }] }),
      );

    const provider = new HttpEmbeddingProvider(opts);
    const [vector] = await provider.embed(['hello']);

    expect(vector).toHaveLength(1024);
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as { body: string }).body,
    ) as { model: string; input: string[]; dimensions: number };
    expect(body).toEqual({
      model: 'gemini-embedding-001',
      input: ['hello'],
      dimensions: 1024,
    });
    expect(
      (fetchMock.mock.calls[0][1] as { headers: Record<string, string> })
        .headers.authorization,
    ).toBe('Bearer test-key');
  });

  it('rejects when the returned embedding has the wrong dimension', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        jsonResponse({ data: [{ embedding: Array<number>(768).fill(0.01) }] }),
      );

    const provider = new HttpEmbeddingProvider(opts);
    await expect(provider.embed(['hello'])).rejects.toThrow(/wrong dimension/);
  });

  it('short-circuits on empty input without calling the API', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch');
    const provider = new HttpEmbeddingProvider(opts);
    await expect(provider.embed([])).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
