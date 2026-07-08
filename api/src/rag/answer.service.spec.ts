import { isSupportedVerdict } from './answer.service';

describe('isSupportedVerdict', () => {
  it('accepts a clean supported=true verdict', () => {
    expect(isSupportedVerdict('{"supported": true}')).toBe(true);
  });

  it('accepts supported=true surrounded by extra prose', () => {
    expect(
      isSupportedVerdict('Sure, here it is: {"supported": true} thanks.'),
    ).toBe(true);
  });

  it('rejects a clean supported=false verdict', () => {
    expect(isSupportedVerdict('{"supported": false}')).toBe(false);
  });

  it('rejects verbose hedging text containing the substring "true" (fail closed)', () => {
    // This is the exact regression case: the old substring regex
    // (/"?supported"?\s*:?\s*true/i) matched this and passed, but the verdict
    // clearly means NOT supported.
    expect(
      isSupportedVerdict(
        'The claim is not supported; it would only be true if the source ' +
          'mentioned pricing, which it does not.',
      ),
    ).toBe(false);
  });

  it('rejects malformed / non-JSON responses', () => {
    expect(isSupportedVerdict('supported: true')).toBe(false);
    expect(isSupportedVerdict('')).toBe(false);
    expect(isSupportedVerdict('yes, fully supported')).toBe(false);
  });

  it('rejects invalid JSON inside braces', () => {
    expect(isSupportedVerdict('{supported: true}')).toBe(false);
  });

  it('rejects a non-boolean supported field', () => {
    expect(isSupportedVerdict('{"supported": "true"}')).toBe(false);
    expect(isSupportedVerdict('{"supported": 1}')).toBe(false);
    expect(isSupportedVerdict('{"supported": null}')).toBe(false);
  });

  it('rejects a missing supported field', () => {
    expect(isSupportedVerdict('{"grounded": true}')).toBe(false);
  });

  it('rejects arrays and non-object JSON', () => {
    expect(isSupportedVerdict('[true]')).toBe(false);
    expect(isSupportedVerdict('true')).toBe(false);
  });

  it('parses the first balanced JSON object even with nested braces', () => {
    expect(
      isSupportedVerdict('{"supported": true, "meta": {"nested": 1}}'),
    ).toBe(true);
  });

  it('is not confused by braces inside string literals', () => {
    expect(
      isSupportedVerdict('{"supported": true, "note": "uses { and }"}'),
    ).toBe(true);
  });
});
