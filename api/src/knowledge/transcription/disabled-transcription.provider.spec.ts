import { DisabledTranscriptionProvider } from './disabled-transcription.provider';

describe('DisabledTranscriptionProvider', () => {
  it('reports itself disabled', () => {
    expect(new DisabledTranscriptionProvider().enabled).toBe(false);
  });

  it('rejects when asked to transcribe', async () => {
    await expect(
      new DisabledTranscriptionProvider().transcribe(),
    ).rejects.toThrow(/not enabled/i);
  });
});
