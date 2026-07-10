export type ReportCadence = 'daily' | 'weekly' | 'monthly';

export const REPORT_CADENCES: readonly ReportCadence[] = [
  'daily',
  'weekly',
  'monthly',
];

/**
 * The next run time for a schedule with the given cadence, computed strictly
 * *after* `from` (UTC arithmetic). Deliberately calendar-based rather than a
 * fixed millisecond delta:
 *  - daily   -> +1 day
 *  - weekly  -> +7 days
 *  - monthly -> +1 calendar month (so it tracks month length, not 30 days)
 *
 * The runner calls this off the moment a report was actually generated, so a
 * missed tick doesn't accumulate a backlog — the next run is always one
 * cadence ahead of the last successful run, never of the (possibly late) tick.
 */
export function nextRunAt(cadence: ReportCadence, from: Date): Date {
  const d = new Date(from.getTime());
  switch (cadence) {
    case 'daily':
      d.setUTCDate(d.getUTCDate() + 1);
      return d;
    case 'weekly':
      d.setUTCDate(d.getUTCDate() + 7);
      return d;
    case 'monthly':
      d.setUTCMonth(d.getUTCMonth() + 1);
      return d;
  }
}

/**
 * Whether a schedule is due to run at `now`: it must be enabled and its
 * `nextRunAt` must be at or before `now`. Centralized here (rather than inline
 * in the runner) so the due predicate is unit-testable without a database.
 */
export function isDue(
  schedule: { enabled: boolean; nextRunAt: Date },
  now: Date,
): boolean {
  return schedule.enabled && schedule.nextRunAt.getTime() <= now.getTime();
}

/** Narrowing guard for the cadence string set (used to validate DB rows). */
export function isReportCadence(value: string): value is ReportCadence {
  return (REPORT_CADENCES as readonly string[]).includes(value);
}
