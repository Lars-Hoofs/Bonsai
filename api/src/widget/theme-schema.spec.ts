import { BadRequestException } from '@nestjs/common';
import { validateTheme, sanitizeCustomCss } from './theme-schema';
import { DEFAULT_WIDGET_THEME } from './default-theme';
import { BUILT_IN_PRESETS } from './presets';

describe('validateTheme', () => {
  it('accepts the Bonsai default theme', () => {
    expect(() => validateTheme(DEFAULT_WIDGET_THEME)).not.toThrow();
  });

  it('accepts all built-in presets', () => {
    for (const preset of Object.values(BUILT_IN_PRESETS)) {
      expect(() => validateTheme(preset.theme)).not.toThrow();
    }
  });

  it('accepts a minimal empty-ish theme (all fields optional)', () => {
    expect(() => validateTheme({ version: 1 })).not.toThrow();
  });

  it('rejects a non-object payload', () => {
    expect(() => validateTheme('nope')).toThrow(BadRequestException);
    expect(() => validateTheme(null)).toThrow(BadRequestException);
    expect(() => validateTheme(42)).toThrow(BadRequestException);
  });

  it('rejects unknown top-level keys', () => {
    expect(() => validateTheme({ version: 1, bogus: true })).toThrow(
      /unknown/i,
    );
  });

  describe('colors', () => {
    it('accepts valid hex colors', () => {
      expect(() =>
        validateTheme({
          colors: {
            primary: '#7C3AED',
            background: '#FFFFFF',
            text: '#0F172A',
          },
        }),
      ).not.toThrow();
    });

    it('rejects an invalid hex color', () => {
      expect(() => validateTheme({ colors: { primary: 'not-a-hex' } })).toThrow(
        /hex/i,
      );
    });

    it('rejects unknown keys under colors', () => {
      expect(() =>
        validateTheme({ colors: { primary: '#FFFFFF', bogus: '#000000' } }),
      ).toThrow(/unknown/i);
    });
  });

  describe('gradient', () => {
    it('accepts a valid gradient config', () => {
      expect(() =>
        validateTheme({
          gradient: { from: '#7C3AED', to: '#2563EB', centerColor: '#FFFFFF' },
        }),
      ).not.toThrow();
    });

    it('rejects a gradient with a bad hex', () => {
      expect(() =>
        validateTheme({ gradient: { from: 'red', to: '#2563EB' } }),
      ).toThrow(/hex/i);
    });
  });

  describe('radius / spacing / shadow', () => {
    it('accepts numeric radius/spacing within bounds', () => {
      expect(() =>
        validateTheme({ radius: 16, spacing: 8, shadow: 'medium' }),
      ).not.toThrow();
    });

    it('rejects a negative radius', () => {
      expect(() => validateTheme({ radius: -1 })).toThrow();
    });

    it('rejects an invalid shadow enum value', () => {
      expect(() => validateTheme({ shadow: 'ultra-mega' })).toThrow(/shadow/i);
    });

    it('accepts every valid shadow enum value', () => {
      for (const shadow of ['none', 'small', 'medium', 'large']) {
        expect(() => validateTheme({ shadow })).not.toThrow();
      }
    });
  });

  describe('typography', () => {
    it('accepts a valid typography block', () => {
      expect(() =>
        validateTheme({
          typography: {
            fontFamily: 'Inter, system-ui, sans-serif',
            fontSize: 14,
            fontWeight: 400,
          },
        }),
      ).not.toThrow();
    });

    it('rejects a non-numeric fontSize', () => {
      expect(() =>
        validateTheme({ typography: { fontSize: 'huge' } }),
      ).toThrow();
    });

    it('rejects an out-of-range fontWeight', () => {
      expect(() =>
        validateTheme({ typography: { fontWeight: 5000 } }),
      ).toThrow();
    });
  });

  describe('launcher', () => {
    it('accepts a gradient-mode launcher', () => {
      expect(() =>
        validateTheme({
          launcher: {
            iconMode: 'gradient',
            size: 60,
            corner: 'br',
            offset: { x: 20, y: 20 },
          },
        }),
      ).not.toThrow();
    });

    it('accepts a custom-mode launcher with an icon asset ref', () => {
      expect(() =>
        validateTheme({
          launcher: {
            iconMode: 'custom',
            customIconAssetRef: 'asset_abc123',
            size: 60,
            corner: 'bl',
          },
        }),
      ).not.toThrow();
    });

    it('rejects an invalid iconMode', () => {
      expect(() =>
        validateTheme({ launcher: { iconMode: 'sparkles' } }),
      ).toThrow(/iconMode/i);
    });

    it('rejects an invalid corner', () => {
      expect(() => validateTheme({ launcher: { corner: 'middle' } })).toThrow(
        /corner/i,
      );
    });

    it('accepts every valid corner', () => {
      for (const corner of ['br', 'bl', 'tr', 'tl']) {
        expect(() => validateTheme({ launcher: { corner } })).not.toThrow();
      }
    });
  });

  describe('opening animation', () => {
    it('accepts a valid animation + delayMs', () => {
      expect(() =>
        validateTheme({ openingAnimation: { type: 'slide', delayMs: 500 } }),
      ).not.toThrow();
    });

    it('accepts every valid animation type', () => {
      for (const type of ['fade', 'slide', 'bounce', 'none']) {
        expect(() =>
          validateTheme({ openingAnimation: { type } }),
        ).not.toThrow();
      }
    });

    it('rejects an invalid animation type', () => {
      expect(() =>
        validateTheme({ openingAnimation: { type: 'zoom' } }),
      ).toThrow(/openingAnimation/i);
    });

    it('rejects a negative delayMs', () => {
      expect(() =>
        validateTheme({ openingAnimation: { type: 'fade', delayMs: -5 } }),
      ).toThrow();
    });
  });

  describe('welcome message + suggestions', () => {
    it('accepts a welcome message with string suggestions', () => {
      expect(() =>
        validateTheme({
          welcome: {
            message: 'Hi there!',
            suggestions: ['Pricing?', 'Support'],
          },
        }),
      ).not.toThrow();
    });

    it('rejects non-string entries in suggestions', () => {
      expect(() =>
        validateTheme({ welcome: { suggestions: ['ok', 42] } }),
      ).toThrow();
    });

    it('rejects too many suggestions', () => {
      const suggestions = Array.from({ length: 21 }, (_, i) => `q${i}`);
      expect(() => validateTheme({ welcome: { suggestions } })).toThrow();
    });
  });

  describe('avatars', () => {
    it('accepts bot/agent avatar asset refs', () => {
      expect(() =>
        validateTheme({
          avatars: { bot: 'asset_bot1', agent: 'asset_agent1' },
        }),
      ).not.toThrow();
    });

    it('rejects a non-string avatar ref', () => {
      expect(() => validateTheme({ avatars: { bot: 123 } })).toThrow();
    });
  });

  describe('customCss', () => {
    it('accepts a plain customCss string', () => {
      expect(() =>
        validateTheme({ customCss: '.bonsai-widget { color: red; }' }),
      ).not.toThrow();
    });

    it('rejects a customCss string over the max length', () => {
      expect(() => validateTheme({ customCss: 'a'.repeat(20_000) })).toThrow(
        /customCss/i,
      );
    });

    it('rejects a non-string customCss', () => {
      expect(() => validateTheme({ customCss: 123 })).toThrow();
    });
  });

  it('rejects a theme exceeding the 32KB serialized size cap', () => {
    expect(() => validateTheme({ customCss: 'a'.repeat(33_000) })).toThrow(
      BadRequestException,
    );
  });
});

describe('sanitizeCustomCss', () => {
  it('strips closing </style> tags defensively', () => {
    expect(sanitizeCustomCss('a{}</style><script>bad</script>')).not.toMatch(
      /<\/style>/i,
    );
  });

  it('strips <script> sequences defensively', () => {
    expect(sanitizeCustomCss('a{} <script>alert(1)</script>')).not.toMatch(
      /<script/i,
    );
  });

  it('leaves ordinary css untouched', () => {
    const css = '.foo { color: red; padding: 4px; }';
    expect(sanitizeCustomCss(css)).toBe(css);
  });
});
