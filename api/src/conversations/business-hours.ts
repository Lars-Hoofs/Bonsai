/**
 * Business-hours-aware handover (A1): a pure, dependency-free helper (uses
 * only the built-in `Intl` API — no new npm dependency) that decides whether
 * "now" falls inside a project's configured office hours.
 *
 * Design notes:
 *  - `day` is ISO weekday, 1 (Monday) through 7 (Sunday), matching
 *    `Intl`/ISO-8601 convention rather than JS `Date#getDay()` (0=Sunday).
 *  - `open`/`close` are local wall-clock 'HH:MM' (24h) in the schedule's
 *    `timezone` — NOT UTC. The interval is half-open: open <= now < close.
 *  - A schedule with no intervals (or no schedule at all) means "always
 *    open", so projects that never configure business hours keep today's
 *    behavior exactly (escalate always posts the live-agent message).
 *  - An invalid/unsupported IANA timezone must never turn into an escalation
 *    that silently fails to reach a human, so it fails OPEN (returns true)
 *    rather than throwing or reporting closed.
 */

export interface BusinessHoursInterval {
  /** ISO weekday: 1 = Monday, ..., 7 = Sunday. */
  day: number;
  /** Local 24h time, 'HH:MM', inclusive. */
  open: string;
  /** Local 24h time, 'HH:MM', exclusive. */
  close: string;
}

export interface BusinessHours {
  /** IANA timezone name, e.g. 'Europe/Amsterdam'. */
  timezone: string;
  intervals: BusinessHoursInterval[];
}

/** Minutes since local midnight for an 'HH:MM' string. */
function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((s) => Number(s));
  return h * 60 + m;
}

/** Maps `Intl.DateTimeFormat`'s weekday name to an ISO weekday (1..7). */
const WEEKDAY_TO_ISO: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

/**
 * Resolves `at` to its ISO weekday (1..7) and minutes-since-local-midnight
 * in `timezone`, using `Intl.DateTimeFormat` so DST and timezone offsets are
 * handled correctly without any manual offset math. Returns `null` if the
 * timezone is not recognized (e.g. typo'd IANA name) so the caller can fail
 * open.
 */
function resolveLocalWeekdayAndMinutes(
  timezone: string,
  at: Date,
): { isoWeekday: number; minutes: number } | null {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    const parts = formatter.formatToParts(at);
    const weekdayPart = parts.find((p) => p.type === 'weekday')?.value;
    const hourPart = parts.find((p) => p.type === 'hour')?.value;
    const minutePart = parts.find((p) => p.type === 'minute')?.value;
    if (!weekdayPart || hourPart === undefined || minutePart === undefined) {
      return null;
    }
    const isoWeekday = WEEKDAY_TO_ISO[weekdayPart];
    if (!isoWeekday) return null;
    const hour = Number(hourPart);
    const minute = Number(minutePart);
    if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
    // hourCycle 'h23' can format local midnight as "24"; normalize to 0.
    const normalizedHour = hour === 24 ? 0 : hour;
    return { isoWeekday, minutes: normalizedHour * 60 + minute };
  } catch {
    // Unknown/invalid timezone (e.g. RangeError from Intl) -> caller fails
    // open.
    return null;
  }
}

/**
 * Returns true iff `at` falls within the schedule's configured business
 * hours. `schedule` being null/undefined, or having no intervals, always
 * returns true (no schedule configured = always open, today's behavior).
 * An unresolvable timezone also returns true (fail open).
 */
export function isOpen(
  schedule: BusinessHours | undefined | null,
  at: Date,
): boolean {
  if (!schedule || schedule.intervals.length === 0) return true;

  const resolved = resolveLocalWeekdayAndMinutes(schedule.timezone, at);
  if (!resolved) return true;

  const { isoWeekday, minutes } = resolved;
  return schedule.intervals.some((interval) => {
    if (interval.day !== isoWeekday) return false;
    const openMinutes = toMinutes(interval.open);
    const closeMinutes = toMinutes(interval.close);
    return minutes >= openMinutes && minutes < closeMinutes;
  });
}
