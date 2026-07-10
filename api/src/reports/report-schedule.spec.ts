import {
  isDue,
  isReportCadence,
  nextRunAt,
  REPORT_CADENCES,
} from './report-schedule';

describe('nextRunAt', () => {
  const from = new Date('2026-07-10T09:00:00.000Z');

  it('advances daily by one day (UTC)', () => {
    expect(nextRunAt('daily', from).toISOString()).toBe(
      '2026-07-11T09:00:00.000Z',
    );
  });

  it('advances weekly by seven days', () => {
    expect(nextRunAt('weekly', from).toISOString()).toBe(
      '2026-07-17T09:00:00.000Z',
    );
  });

  it('advances monthly by one calendar month', () => {
    expect(nextRunAt('monthly', from).toISOString()).toBe(
      '2026-08-10T09:00:00.000Z',
    );
  });

  it('monthly tracks month length across year boundary', () => {
    const dec = new Date('2026-12-15T00:00:00.000Z');
    expect(nextRunAt('monthly', dec).toISOString()).toBe(
      '2027-01-15T00:00:00.000Z',
    );
  });

  it('does not mutate the input date', () => {
    const original = from.getTime();
    nextRunAt('weekly', from);
    expect(from.getTime()).toBe(original);
  });
});

describe('isDue', () => {
  const now = new Date('2026-07-10T12:00:00.000Z');

  it('is due when enabled and nextRunAt is in the past', () => {
    expect(
      isDue(
        { enabled: true, nextRunAt: new Date('2026-07-10T11:59:59.000Z') },
        now,
      ),
    ).toBe(true);
  });

  it('is due exactly at nextRunAt', () => {
    expect(isDue({ enabled: true, nextRunAt: now }, now)).toBe(true);
  });

  it('is not due when nextRunAt is still in the future', () => {
    expect(
      isDue(
        { enabled: true, nextRunAt: new Date('2026-07-10T12:00:01.000Z') },
        now,
      ),
    ).toBe(false);
  });

  it('is never due when disabled, even if overdue', () => {
    expect(
      isDue(
        { enabled: false, nextRunAt: new Date('2020-01-01T00:00:00.000Z') },
        now,
      ),
    ).toBe(false);
  });
});

describe('isReportCadence', () => {
  it('accepts the known cadences and rejects others', () => {
    for (const c of REPORT_CADENCES) expect(isReportCadence(c)).toBe(true);
    expect(isReportCadence('hourly')).toBe(false);
    expect(isReportCadence('')).toBe(false);
  });
});
