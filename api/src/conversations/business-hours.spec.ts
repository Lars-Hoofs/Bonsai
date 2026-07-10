import { BusinessHours, isOpen } from './business-hours';

// Fixed instants for deterministic, DST-safe assertions. Amsterdam is
// UTC+1 in winter (CET) and UTC+2 in summer (CEST) — using both a January
// and a July timestamp exercises the DST transition without relying on the
// system's local timezone (Intl resolves everything from the IANA tz name
// passed in the schedule, not from the process's local tz).
const WINTER_TUESDAY_10AM_UTC = new Date('2024-01-09T10:00:00.000Z'); // Tue, CET (UTC+1) -> 11:00 local
const SUMMER_TUESDAY_10AM_UTC = new Date('2024-07-09T10:00:00.000Z'); // Tue, CEST (UTC+2) -> 12:00 local

const schedule: BusinessHours = {
  timezone: 'Europe/Amsterdam',
  intervals: [
    { day: 1, open: '09:00', close: '17:00' }, // Monday
    { day: 2, open: '09:00', close: '17:00' }, // Tuesday
    { day: 3, open: '09:00', close: '17:00' }, // Wednesday
    { day: 4, open: '09:00', close: '17:00' }, // Thursday
    { day: 5, open: '09:00', close: '17:00' }, // Friday
  ],
};

describe('isOpen', () => {
  it('returns true when schedule is undefined (preserves current always-open behavior)', () => {
    expect(isOpen(undefined, new Date())).toBe(true);
  });

  it('returns true when schedule is null', () => {
    expect(isOpen(null, new Date())).toBe(true);
  });

  it('returns true when schedule has no intervals', () => {
    expect(
      isOpen({ timezone: 'Europe/Amsterdam', intervals: [] }, new Date()),
    ).toBe(true);
  });

  it('returns true for a time inside the interval (winter, CET)', () => {
    // 2024-01-09T10:00:00Z is 11:00 in Amsterdam (CET, UTC+1) on a Tuesday.
    expect(isOpen(schedule, WINTER_TUESDAY_10AM_UTC)).toBe(true);
  });

  it('returns true for a time inside the interval (summer, CEST) — DST-safe', () => {
    // 2024-07-09T10:00:00Z is 12:00 in Amsterdam (CEST, UTC+2) on a Tuesday.
    expect(isOpen(schedule, SUMMER_TUESDAY_10AM_UTC)).toBe(true);
  });

  it('returns false for a time outside the interval (before opening)', () => {
    // 07:00 UTC on the winter Tuesday is 08:00 CET local -> before 09:00 open.
    const before = new Date('2024-01-09T07:00:00.000Z');
    expect(isOpen(schedule, before)).toBe(false);
  });

  it('returns false for a time outside the interval (after closing)', () => {
    // 17:00 UTC on the winter Tuesday is 18:00 CET local -> after 17:00 close.
    const after = new Date('2024-01-09T17:00:00.000Z');
    expect(isOpen(schedule, after)).toBe(false);
  });

  it('is closed-at-boundary on close (open <= now < close, exclusive close)', () => {
    // Exactly 17:00 local (16:00 UTC in winter) must be closed.
    const atClose = new Date('2024-01-09T16:00:00.000Z');
    expect(isOpen(schedule, atClose)).toBe(false);
  });

  it('is open-at-boundary on open (inclusive open)', () => {
    // Exactly 09:00 local (08:00 UTC in winter) must be open.
    const atOpen = new Date('2024-01-09T08:00:00.000Z');
    expect(isOpen(schedule, atOpen)).toBe(true);
  });

  it('returns false for the wrong weekday (Saturday, no interval configured)', () => {
    // 2024-01-13 is a Saturday; schedule only has Mon-Fri intervals.
    const saturday = new Date('2024-01-13T10:00:00.000Z');
    expect(isOpen(schedule, saturday)).toBe(false);
  });

  it('returns true on Sunday when an explicit Sunday interval (day 7) covers the time', () => {
    const sundaySchedule: BusinessHours = {
      timezone: 'Europe/Amsterdam',
      intervals: [{ day: 7, open: '10:00', close: '14:00' }],
    };
    // 2024-01-14 is a Sunday; 11:00 UTC -> 12:00 CET local, inside 10:00-14:00.
    const sunday = new Date('2024-01-14T11:00:00.000Z');
    expect(isOpen(sundaySchedule, sunday)).toBe(true);
  });

  it('supports multiple intervals for the same day (e.g. lunch break split)', () => {
    const splitSchedule: BusinessHours = {
      timezone: 'Europe/Amsterdam',
      intervals: [
        { day: 2, open: '09:00', close: '12:00' },
        { day: 2, open: '13:00', close: '17:00' },
      ],
    };
    // 12:30 local (winter, CET) falls in the lunch gap -> closed.
    const duringLunch = new Date('2024-01-09T11:30:00.000Z');
    expect(isOpen(splitSchedule, duringLunch)).toBe(false);
    // 14:00 local -> open (second interval).
    const afternoon = new Date('2024-01-09T13:00:00.000Z');
    expect(isOpen(splitSchedule, afternoon)).toBe(true);
  });

  it('fails OPEN when the timezone is invalid (misconfiguration must never block escalation)', () => {
    const bogus: BusinessHours = {
      timezone: 'Not/ARealTimezone',
      intervals: [{ day: 1, open: '09:00', close: '17:00' }],
    };
    expect(isOpen(bogus, new Date())).toBe(true);
  });
});
