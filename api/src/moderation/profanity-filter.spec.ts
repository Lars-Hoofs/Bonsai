import {
  detectProfanity,
  normalize,
  readProfanityConfig,
} from './profanity-filter';

describe('normalize', () => {
  it('lower-cases and strips non-letters', () => {
    expect(normalize('He.l-lo!')).toBe('hello');
  });

  it('maps common leetspeak digits/symbols to letters', () => {
    expect(normalize('f0o')).toBe('foo');
    expect(normalize('$h1t')).toBe('shit');
    expect(normalize('@ss')).toBe('ass');
  });

  it('collapses separators used for evasion', () => {
    expect(normalize('s h i t')).toBe('shit');
    expect(normalize('f-u-c-k')).toBe('fuck');
  });
});

describe('detectProfanity', () => {
  it.each([
    'you are a piece of shit',
    'what the fuck',
    'wat een kut antwoord',
    'jij bent een klootzak',
    'this bot is fucking useless',
  ])('detects profanity in: %s', (text) => {
    expect(detectProfanity(text).matched).toBe(true);
  });

  it('catches leetspeak/separator evasion', () => {
    expect(detectProfanity('sh1t').matched).toBe(true);
    expect(detectProfanity('f u c k you').matched).toBe(true);
  });

  it.each([
    'wat zijn de openingstijden',
    'can you help me with my order',
    'ik wil graag een retour aanvragen',
    'thanks for the help',
  ])('does not flag neutral text: %s', (text) => {
    expect(detectProfanity(text).matched).toBe(false);
  });

  it('returns the distinct matched terms', () => {
    const res = detectProfanity('shit shit fuck');
    expect(res.matched).toBe(true);
    expect(res.terms.sort()).toEqual(['fuck', 'shit']);
  });

  it('honors project extraTerms', () => {
    expect(detectProfanity('this is spam').matched).toBe(false);
    expect(
      detectProfanity('this is spam', { extraTerms: ['spam'] }).matched,
    ).toBe(true);
  });

  it('honors project allowTerms to carve out false positives', () => {
    expect(detectProfanity('scunthorpe', { allowTerms: [] }).matched).toBe(
      true,
    );
    expect(
      detectProfanity('scunthorpe', { allowTerms: ['cunt'] }).matched,
    ).toBe(false);
  });

  it('returns no match for empty/whitespace input', () => {
    expect(detectProfanity('   ').matched).toBe(false);
    expect(detectProfanity('').matched).toBe(false);
  });
});

describe('readProfanityConfig', () => {
  it('defaults to disabled when unset', () => {
    expect(readProfanityConfig({})).toEqual({ enabled: false, action: 'flag' });
  });

  it('defaults to disabled for malformed shapes', () => {
    expect(readProfanityConfig({ profanityFilter: 'nope' }).enabled).toBe(
      false,
    );
    expect(readProfanityConfig({ profanityFilter: [] }).enabled).toBe(false);
    expect(
      readProfanityConfig({ profanityFilter: { enabled: 'yes' } }).enabled,
    ).toBe(false);
  });

  it('reads an enabled config with a valid action', () => {
    expect(
      readProfanityConfig({
        profanityFilter: { enabled: true, action: 'block' },
      }),
    ).toEqual({ enabled: true, action: 'block' });
  });

  it('falls back to flag for an invalid action', () => {
    expect(
      readProfanityConfig({
        profanityFilter: { enabled: true, action: 'nuke' },
      }).action,
    ).toBe('flag');
  });

  it('reads and filters extraTerms/allowTerms', () => {
    const cfg = readProfanityConfig({
      profanityFilter: {
        enabled: true,
        action: 'warn',
        extraTerms: ['spam', 42, 'lame'],
        allowTerms: ['ok'],
      },
    });
    expect(cfg.extraTerms).toEqual(['spam', 'lame']);
    expect(cfg.allowTerms).toEqual(['ok']);
  });
});
