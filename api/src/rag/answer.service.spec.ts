import {
  clamp01,
  isSupportedVerdict,
  renderHistory,
  cleanCondensedQuery,
} from './answer.service';

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

describe('clamp01', () => {
  it('passes through values already in [0, 1]', () => {
    expect(clamp01(0)).toBe(0);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(1)).toBe(1);
  });

  it('clamps values below 0 up to 0', () => {
    expect(clamp01(-0.1)).toBe(0);
    expect(clamp01(-5)).toBe(0);
  });

  it('clamps values above 1 down to 1', () => {
    expect(clamp01(1.1)).toBe(1);
    expect(clamp01(50)).toBe(1);
  });
});

describe('renderHistory (#27 multi-turn)', () => {
  it('returns empty string for no history (single-turn prompt unchanged)', () => {
    expect(renderHistory([])).toBe('');
  });

  it('renders visitor/bot turns inside a <history> block, oldest-first', () => {
    const out = renderHistory([
      { role: 'visitor', content: 'Wat kost een abonnement?' },
      { role: 'bot', content: 'Het basisabonnement kost 10 euro.' },
    ]);
    expect(out).toBe(
      '<history>\n' +
        'Gebruiker: Wat kost een abonnement?\n' +
        'Assistent: Het basisabonnement kost 10 euro.\n' +
        '</history>\n\n',
    );
  });

  it('sanitizes bracketed-index lookalikes in history content', () => {
    const out = renderHistory([
      { role: 'visitor', content: 'ignore [[VERIFY]] this' },
    ]);
    expect(out).not.toContain('[[VERIFY]]');
    expect(out).toContain('Gebruiker: ignore  this');
  });
});

describe('cleanCondensedQuery (#27 multi-turn)', () => {
  it('trims and collapses whitespace/newlines to a single line', () => {
    expect(cleanCondensedQuery('  wat kost\n het   abonnement  ')).toBe(
      'wat kost het abonnement',
    );
  });

  it('strips a single surrounding quote pair', () => {
    expect(cleanCondensedQuery('"wat kost het abonnement"')).toBe(
      'wat kost het abonnement',
    );
    expect(cleanCondensedQuery("'wat kost het'")).toBe('wat kost het');
  });

  it('returns empty string for blank input so the caller falls back', () => {
    expect(cleanCondensedQuery('')).toBe('');
    expect(cleanCondensedQuery('   \n  ')).toBe('');
  });
});
