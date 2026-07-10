import { WhisperTranscriptionProvider } from './whisper-transcription.provider';

const OPTS = {
  endpoint: 'http://whisper:8000/v1/audio/transcriptions',
  model: 'whisper-1',
  timeoutMs: 5_000,
};

describe('WhisperTranscriptionProvider', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it('is enabled', () => {
    expect(new WhisperTranscriptionProvider(OPTS).enabled).toBe(true);
  });

  it('posts multipart form-data and returns { text }', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    global.fetch = jest.fn((url: unknown, init: unknown) => {
      captured = { url: String(url), init: init as RequestInit };
      return Promise.resolve(
        new Response(JSON.stringify({ text: '  hello world  ' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });

    const provider = new WhisperTranscriptionProvider(OPTS);
    const text = await provider.transcribe(
      Buffer.from('fake-audio-bytes'),
      'meeting.mp3',
      'audio/mpeg',
    );

    expect(text).toBe('hello world');
    expect(captured?.url).toBe(OPTS.endpoint);
    expect(captured?.init.method).toBe('POST');
    expect(captured?.init.body).toBeInstanceOf(FormData);
    const form = captured?.init.body as FormData;
    expect(form.get('model')).toBe('whisper-1');
    expect(form.get('file')).toBeInstanceOf(Blob);
  });

  it('accepts a bare-string transcript response', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve(new Response('just text', { status: 200 })),
    );
    const text = await new WhisperTranscriptionProvider(OPTS).transcribe(
      Buffer.from('x'),
      'a.wav',
      'audio/wav',
    );
    expect(text).toBe('just text');
  });

  it('sends a bearer header only when an api key is set', async () => {
    const fetchMock = jest.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ text: 'ok' }), { status: 200 }),
      ),
    );
    global.fetch = fetchMock;

    await new WhisperTranscriptionProvider(OPTS).transcribe(
      Buffer.from('x'),
      'a.wav',
      'audio/wav',
    );
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toBeUndefined();

    await new WhisperTranscriptionProvider({
      ...OPTS,
      apiKey: 'secret',
    }).transcribe(Buffer.from('x'), 'a.wav', 'audio/wav');
    expect((fetchMock.mock.calls[1][1] as RequestInit).headers).toEqual({
      authorization: 'Bearer secret',
    });
  });

  it('throws on a non-2xx response', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve(new Response('boom', { status: 500 })),
    );
    await expect(
      new WhisperTranscriptionProvider(OPTS).transcribe(
        Buffer.from('x'),
        'a.wav',
        'audio/wav',
      ),
    ).rejects.toThrow(/Whisper API error 500/);
  });

  it('throws on an unexpected response shape', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ nope: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    await expect(
      new WhisperTranscriptionProvider(OPTS).transcribe(
        Buffer.from('x'),
        'a.wav',
        'audio/wav',
      ),
    ).rejects.toThrow(/unexpected shape/);
  });
});
