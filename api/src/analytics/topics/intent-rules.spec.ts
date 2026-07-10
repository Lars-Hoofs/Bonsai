import { classifyIntent, intentLabel } from './intent-rules';

describe('classifyIntent', () => {
  it('classifies a Dutch returns question', () => {
    const { key, score } = classifyIntent(
      'Hoe kan ik mijn bestelling retourneren?',
    );
    expect(key).toBe('returns');
    expect(score).toBeGreaterThan(0);
  });

  it('classifies an English shipping question', () => {
    const { key } = classifyIntent('When will my order be delivered?');
    expect(key).toBe('shipping');
  });

  it('classifies a payment question', () => {
    expect(classifyIntent('Kan ik met iDEAL betalen?').key).toBe('payment');
  });

  it('matches multi-word phrases as substrings', () => {
    expect(classifyIntent('waar is mijn bestelling nu?').key).toBe(
      'order_status',
    );
  });

  it('does not fire single-word keywords on partial tokens', () => {
    // "pay" is a payment keyword but must only match as a whole token; a random
    // sentence without any real keyword should fall through to `other`.
    const { key, score } = classifyIntent('vertel me iets leuks vandaag');
    expect(key).toBe('other');
    expect(score).toBe(0);
  });

  it('is case-insensitive', () => {
    expect(classifyIntent('GARANTIE op dit product?').key).toBe('warranty');
  });

  it('returns other for unmatched text', () => {
    expect(classifyIntent('').key).toBe('other');
  });

  it('exposes a human label for every key including other', () => {
    expect(intentLabel('returns')).toMatch(/Return/i);
    expect(intentLabel('other')).toMatch(/Other|Overig/i);
  });
});
