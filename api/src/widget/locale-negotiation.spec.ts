import { negotiateCopy, parseAcceptLanguage } from './locale-negotiation';

describe('parseAcceptLanguage', () => {
  it('returns [] for undefined/empty', () => {
    expect(parseAcceptLanguage(undefined)).toEqual([]);
    expect(parseAcceptLanguage('')).toEqual([]);
  });

  it('orders by q-weight, lowercases, and drops the wildcard', () => {
    expect(parseAcceptLanguage('en-US,fr;q=0.9,nl;q=0.5,*;q=0.1')).toEqual([
      'en-us',
      'fr',
      'nl',
    ]);
  });

  it('defaults missing q to 1 (most preferred)', () => {
    expect(parseAcceptLanguage('de;q=0.4,en')).toEqual(['en', 'de']);
  });

  it('drops q=0 entries', () => {
    expect(parseAcceptLanguage('en;q=0,nl;q=0.8')).toEqual(['nl']);
  });
});

describe('negotiateCopy', () => {
  const available = {
    en: { welcome: 'Hi' },
    nl: { welcome: 'Hoi' },
    'pt-br': { welcome: 'Ola' },
  };

  it('returns null when no copy exists', () => {
    expect(negotiateCopy({}, ['en'], 'en')).toBeNull();
  });

  it('exact-matches a requested locale', () => {
    expect(negotiateCopy(available, ['nl'], 'en')).toEqual({
      locale: 'nl',
      copy: { welcome: 'Hoi' },
    });
  });

  it('matches a regional request to the primary subtag', () => {
    expect(negotiateCopy(available, ['en-us'], 'nl')).toEqual({
      locale: 'en',
      copy: { welcome: 'Hi' },
    });
  });

  it('matches a bare request to an available regional locale', () => {
    expect(negotiateCopy(available, ['pt'], 'en')).toEqual({
      locale: 'pt-br',
      copy: { welcome: 'Ola' },
    });
  });

  it('honors request order over default locale', () => {
    expect(negotiateCopy(available, ['nl', 'en'], 'en').locale).toBe('nl');
  });

  it('falls back to the default locale when nothing requested matches', () => {
    expect(negotiateCopy(available, ['de', 'fr'], 'nl').locale).toBe('nl');
  });

  it('falls back to the first available locale when even default is absent', () => {
    const result = negotiateCopy({ nl: { welcome: 'Hoi' } }, ['de'], 'en');
    expect(result).toEqual({ locale: 'nl', copy: { welcome: 'Hoi' } });
  });
});
