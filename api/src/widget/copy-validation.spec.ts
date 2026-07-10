import { BadRequestException } from '@nestjs/common';
import { assertCopyShape, normalizeLocale } from './copy-validation';

describe('normalizeLocale', () => {
  it.each([
    ['en', 'en'],
    ['EN', 'en'],
    ['en-US', 'en-us'],
    ['zh-Hant', 'zh-hant'],
    ['pt-BR', 'pt-br'],
  ])('normalizes %p -> %p', (input, expected) => {
    expect(normalizeLocale(input)).toBe(expected);
  });

  it.each(['', 'e', 'english!', '123', 'en_US', 'toolongsubtaghere'])(
    'rejects malformed locale %p',
    (input) => {
      expect(() => normalizeLocale(input)).toThrow(BadRequestException);
    },
  );
});

describe('assertCopyShape', () => {
  it('accepts a valid multi-locale map and normalizes locale keys', () => {
    const out = assertCopyShape({
      EN: { welcome: 'Hi' },
      'nl-NL': { welcome: 'Hoi' },
    });
    expect(out).toEqual({
      en: { welcome: 'Hi' },
      'nl-nl': { welcome: 'Hoi' },
    });
  });

  it('accepts an empty object', () => {
    expect(assertCopyShape({})).toEqual({});
  });

  it.each([null, undefined, 'x', 42, [], true])(
    'rejects non-plain-object copy: %p',
    (value) => {
      expect(() => assertCopyShape(value)).toThrow(BadRequestException);
    },
  );

  it('rejects a locale whose value is not a plain object', () => {
    expect(() => assertCopyShape({ en: 'not an object' })).toThrow(
      /must be a plain object/,
    );
  });

  it('rejects a non-string copy value', () => {
    expect(() => assertCopyShape({ en: { welcome: 42 } })).toThrow(
      /must be a string/,
    );
  });

  it('rejects an invalid locale key', () => {
    expect(() => assertCopyShape({ not_a_locale: { a: 'b' } })).toThrow(
      /Invalid locale/,
    );
  });

  it('rejects copy exceeding the serialized size cap', () => {
    expect(() => assertCopyShape({ en: { blob: 'x'.repeat(70_000) } })).toThrow(
      'Copy too large',
    );
  });

  it('rejects too many locales', () => {
    const copy: Record<string, unknown> = {};
    for (let i = 0; i < 51; i++) copy[`l${i}`] = { a: 'b' };
    expect(() => assertCopyShape(copy)).toThrow('Too many locales');
  });

  it('rejects too many keys within a locale', () => {
    const entry: Record<string, string> = {};
    for (let i = 0; i < 201; i++) entry[`k${i}`] = 'v';
    expect(() => assertCopyShape({ en: entry })).toThrow(/Too many keys/);
  });

  it('rejects a copy value that is too long', () => {
    expect(() =>
      assertCopyShape({ en: { welcome: 'x'.repeat(4_001) } }),
    ).toThrow(/too long/);
  });

  it('collapses locale keys that normalize to the same tag into a duplicate error', () => {
    expect(() => assertCopyShape({ en: { a: 'b' }, EN: { a: 'c' } })).toThrow(
      /Duplicate locale/,
    );
  });
});
