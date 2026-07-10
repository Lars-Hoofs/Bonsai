import {
  DEFAULT_FALLBACK_CHAIN,
  isFallbackStage,
  resolveFallbackChain,
} from './fallback-chain';

describe('resolveFallbackChain', () => {
  it('defaults to KB -> connector -> human when unset', () => {
    const r = resolveFallbackChain({});
    expect(r.stages).toEqual([...DEFAULT_FALLBACK_CHAIN]);
    expect(r.usesKb).toBe(true);
    expect(r.usesConnector).toBe(true);
    expect(r.usesHuman).toBe(true);
  });

  it('defaults when settings is null/undefined', () => {
    expect(resolveFallbackChain(null).stages).toEqual([
      ...DEFAULT_FALLBACK_CHAIN,
    ]);
    expect(resolveFallbackChain(undefined).stages).toEqual([
      ...DEFAULT_FALLBACK_CHAIN,
    ]);
  });

  it('reads an explicit chain of stage strings, preserving order', () => {
    const r = resolveFallbackChain({ fallbackChain: ['kb', 'human'] });
    expect(r.stages).toEqual(['kb', 'human']);
    expect(r.usesKb).toBe(true);
    expect(r.usesConnector).toBe(false);
    expect(r.usesHuman).toBe(true);
  });

  it('reads a chain of { type } objects', () => {
    const r = resolveFallbackChain({
      fallbackChain: [{ type: 'connector' }, { type: 'human' }],
    });
    expect(r.stages).toEqual(['connector', 'human']);
    expect(r.usesKb).toBe(false);
  });

  it('accepts a mix of strings and objects', () => {
    const r = resolveFallbackChain({
      fallbackChain: ['kb', { type: 'connector' }],
    });
    expect(r.stages).toEqual(['kb', 'connector']);
  });

  it('deduplicates, keeping first occurrence order', () => {
    const r = resolveFallbackChain({
      fallbackChain: ['human', 'kb', 'human', 'kb'],
    });
    expect(r.stages).toEqual(['human', 'kb']);
  });

  it('drops unknown/malformed stages', () => {
    const r = resolveFallbackChain({
      fallbackChain: ['kb', 'bogus', 42, null, { type: 'nope' }, 'connector'],
    });
    expect(r.stages).toEqual(['kb', 'connector']);
  });

  it('falls back to the default when the array yields no valid stages', () => {
    const r = resolveFallbackChain({ fallbackChain: ['bogus', 123] });
    expect(r.stages).toEqual([...DEFAULT_FALLBACK_CHAIN]);
  });

  it('falls back to the default when the value is not an array', () => {
    expect(resolveFallbackChain({ fallbackChain: 'kb' }).stages).toEqual([
      ...DEFAULT_FALLBACK_CHAIN,
    ]);
    expect(resolveFallbackChain({ fallbackChain: {} }).stages).toEqual([
      ...DEFAULT_FALLBACK_CHAIN,
    ]);
  });

  it('supports a KB-only chain (no connector, no human)', () => {
    const r = resolveFallbackChain({ fallbackChain: ['kb'] });
    expect(r.usesKb).toBe(true);
    expect(r.usesConnector).toBe(false);
    expect(r.usesHuman).toBe(false);
  });
});

describe('isFallbackStage', () => {
  it.each(['kb', 'connector', 'human'])('accepts %s', (s) => {
    expect(isFallbackStage(s)).toBe(true);
  });

  it.each(['', 'KB', 'agent', 42, null, undefined, {}])('rejects %p', (v) => {
    expect(isFallbackStage(v)).toBe(false);
  });
});
