import {
  DEFLECTION_DEFAULT_DAYS,
  DEFLECTION_MAX_DAYS,
  trailingDays,
} from './analytics.service';

describe('trailingDays', () => {
  it('returns `count` inclusive UTC days ending at now, oldest first', () => {
    const now = new Date('2024-03-05T12:34:56.000Z');
    expect(trailingDays(now, 3)).toEqual([
      '2024-03-03',
      '2024-03-04',
      '2024-03-05',
    ]);
  });

  it('is DST-agnostic (pure UTC calendar days)', () => {
    // Around the Europe/Amsterdam DST switch — result stays in UTC days.
    const now = new Date('2024-03-31T01:00:00.000Z');
    expect(trailingDays(now, 2)).toEqual(['2024-03-30', '2024-03-31']);
  });

  it('crosses month and year boundaries', () => {
    const now = new Date('2025-01-01T00:00:00.000Z');
    expect(trailingDays(now, 3)).toEqual([
      '2024-12-30',
      '2024-12-31',
      '2025-01-01',
    ]);
  });

  it('produces exactly `count` days', () => {
    const now = new Date('2024-07-10T00:00:00.000Z');
    expect(trailingDays(now, DEFLECTION_DEFAULT_DAYS)).toHaveLength(
      DEFLECTION_DEFAULT_DAYS,
    );
    expect(trailingDays(now, DEFLECTION_MAX_DAYS)).toHaveLength(
      DEFLECTION_MAX_DAYS,
    );
  });

  it('handles a single-day range', () => {
    const now = new Date('2024-07-10T23:59:59.000Z');
    expect(trailingDays(now, 1)).toEqual(['2024-07-10']);
  });
});
