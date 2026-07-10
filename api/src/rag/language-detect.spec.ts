import { detectLanguage } from './language-detect';

describe('detectLanguage', () => {
  it('detects Dutch from a typical visitor question', () => {
    expect(detectLanguage('wat zijn de openingstijden van de winkel')).toBe(
      'nl',
    );
  });

  it('detects English from a typical visitor question', () => {
    expect(detectLanguage('what are your opening hours today')).toBe('en');
  });

  it('detects Dutch via distinctive stopwords even without diacritics', () => {
    expect(
      detectLanguage('ik wil graag weten hoe ik mijn bestelling kan volgen'),
    ).toBe('nl');
  });

  it('detects English via distinctive stopwords', () => {
    expect(detectLanguage('could you please tell me where my order is')).toBe(
      'en',
    );
  });

  it('defaults to nl on an empty string (ambiguous, NL-first product)', () => {
    expect(detectLanguage('')).toBe('nl');
  });

  it('defaults to nl on text with no recognizable stopwords (ambiguous)', () => {
    expect(detectLanguage('12345 !!! ???')).toBe('nl');
  });

  it('defaults to nl on a tie between nl/en signals (ambiguous)', () => {
    // "de" (nl) vs "the" (en) — contrived tie scenario resolved by NL-first default.
    expect(detectLanguage('de the')).toBe('nl');
  });
});
