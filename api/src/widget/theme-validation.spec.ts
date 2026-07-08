import { BadRequestException } from '@nestjs/common';
import { assertThemeShape } from './theme-validation';

describe('assertThemeShape', () => {
  it('accepts a small, shallow plain object', () => {
    expect(() =>
      assertThemeShape({ primaryColor: '#123456', fontFamily: 'Inter' }),
    ).not.toThrow();
  });

  it('accepts an empty object', () => {
    expect(() => assertThemeShape({})).not.toThrow();
  });

  it('accepts nested objects/arrays within the depth limit', () => {
    const theme = {
      colors: { primary: '#fff', secondary: { hover: '#000' } },
      links: [{ label: 'a', url: 'https://example.com' }],
    };
    expect(() => assertThemeShape(theme)).not.toThrow();
  });

  it.each([null, undefined, 'a string', 42, true, ['array', 'not', 'object']])(
    'rejects non-plain-object value: %p',
    (value) => {
      expect(() => assertThemeShape(value)).toThrow(BadRequestException);
      expect(() => assertThemeShape(value)).toThrow(
        'Invalid theme: must be a plain object',
      );
    },
  );

  it('rejects a class-instance object (non-Object.prototype)', () => {
    class Foo {
      bar = 1;
    }
    expect(() => assertThemeShape(new Foo())).toThrow(
      'Invalid theme: must be a plain object',
    );
  });

  it('rejects a theme whose serialized size exceeds 32768 chars', () => {
    const theme = { blob: 'x'.repeat(33_000) };
    expect(() => assertThemeShape(theme)).toThrow(BadRequestException);
    expect(() => assertThemeShape(theme)).toThrow('Theme too large');
  });

  it('accepts a theme just under the size cap', () => {
    // Leave headroom for the JSON wrapper (`{"blob":"..."}`).
    const theme = { blob: 'x'.repeat(32_000) };
    expect(() => assertThemeShape(theme)).not.toThrow();
  });

  it('rejects nesting deeper than 8 levels', () => {
    let theme: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 9; i++) {
      theme = { nested: theme };
    }
    expect(() => assertThemeShape(theme)).toThrow(BadRequestException);
    expect(() => assertThemeShape(theme)).toThrow('Theme nesting too deep');
  });

  it('accepts nesting exactly at the 8-level limit', () => {
    let theme: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 7; i++) {
      theme = { nested: theme };
    }
    expect(() => assertThemeShape(theme)).not.toThrow();
  });

  it('rejects more than 500 total keys (deep nesting counts too)', () => {
    const theme: Record<string, unknown> = {};
    for (let i = 0; i < 501; i++) {
      theme[`key${i}`] = i;
    }
    expect(() => assertThemeShape(theme)).toThrow(BadRequestException);
    expect(() => assertThemeShape(theme)).toThrow('Theme has too many keys');
  });

  it('accepts exactly 500 total keys', () => {
    const theme: Record<string, unknown> = {};
    for (let i = 0; i < 500; i++) {
      theme[`key${i}`] = i;
    }
    expect(() => assertThemeShape(theme)).not.toThrow();
  });

  it('rejects a pathological deeply-nested payload designed to blow up processing', () => {
    let theme: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 50; i++) {
      theme = { nested: theme, extra: i };
    }
    expect(() => assertThemeShape(theme)).toThrow(BadRequestException);
  });
});
