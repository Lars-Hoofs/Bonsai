import {
  checkContrast,
  contrastRatio,
  isValidHexColor,
  relativeLuminance,
  WCAG_AA_LARGE_TEXT_MIN_RATIO,
  WCAG_AA_NORMAL_TEXT_MIN_RATIO,
} from './contrast';

describe('isValidHexColor', () => {
  it.each(['#FFFFFF', '#000000', '#7C3AED', '#fff', '#abc123'])(
    'accepts valid hex color %s',
    (v) => {
      expect(isValidHexColor(v)).toBe(true);
    },
  );

  it.each(['FFFFFF', '#FFF00', '#GGGGGG', '', 'red', null, undefined, 42])(
    'rejects invalid hex color %p',
    (v) => {
      expect(isValidHexColor(v)).toBe(false);
    },
  );
});

describe('relativeLuminance', () => {
  it('white is 1', () => {
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1, 5);
  });

  it('black is 0', () => {
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5);
  });

  it('expands 3-digit hex the same as its 6-digit equivalent', () => {
    expect(relativeLuminance('#fff')).toBeCloseTo(
      relativeLuminance('#ffffff'),
      10,
    );
  });

  it('throws on invalid input', () => {
    expect(() => relativeLuminance('not-a-color')).toThrow();
  });
});

describe('contrastRatio', () => {
  it('black on white is 21:1 (the maximum ratio)', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 1);
  });

  it('white on black is also 21:1 (order-independent)', () => {
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 1);
  });

  it('identical colors give a ratio of 1:1', () => {
    expect(contrastRatio('#7C3AED', '#7C3AED')).toBeCloseTo(1, 5);
  });

  it('a known mid-contrast pair matches the expected ratio', () => {
    // #767676 on white is the commonly-cited "just passes AA" gray, ~4.54:1.
    expect(contrastRatio('#767676', '#FFFFFF')).toBeCloseTo(4.54, 1);
  });
});

describe('checkContrast', () => {
  it('reports pass for black on white', () => {
    const result = checkContrast('#000000', '#FFFFFF');
    expect(result.ratio).toBeCloseTo(21, 0);
    expect(result.passesAA).toBe(true);
    expect(result.passesAALarge).toBe(true);
  });

  it('reports fail for low-contrast pairs (e.g. light gray on white)', () => {
    const result = checkContrast('#DDDDDD', '#FFFFFF');
    expect(result.ratio).toBeLessThan(WCAG_AA_NORMAL_TEXT_MIN_RATIO);
    expect(result.passesAA).toBe(false);
  });

  it('large-text threshold (3:1) is looser than normal text (4.5:1)', () => {
    expect(WCAG_AA_LARGE_TEXT_MIN_RATIO).toBeLessThan(
      WCAG_AA_NORMAL_TEXT_MIN_RATIO,
    );
  });
});
