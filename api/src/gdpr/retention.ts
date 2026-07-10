/**
 * Pure retention-window logic for the GDPR auto-purge (#47), split out from
 * the DB-touching service so it can be unit-tested without a database.
 *
 * A project configures a `retentionDays` window. A conversation is eligible
 * for purge when its last activity (`updated_at`) is strictly older than the
 * cutoff = now - retentionDays. `retentionDays` of null/undefined/<=0 means
 * "keep forever" — the project is never purged (this is the default, so
 * existing projects are untouched until an admin opts in).
 */

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * True when the project has a positive retention window configured and is
 * therefore in scope for the purge scan. Non-positive / unset windows are
 * "retain forever".
 */
export function retentionEnabled(
  retentionDays: number | null | undefined,
): retentionDays is number {
  return (
    typeof retentionDays === 'number' &&
    Number.isFinite(retentionDays) &&
    retentionDays > 0
  );
}

/**
 * The cutoff instant for a retention window: conversations last active
 * strictly before this are eligible for purge. Returns null when retention
 * is disabled for the project (so the caller skips it entirely).
 */
export function retentionCutoff(
  retentionDays: number | null | undefined,
  now: Date,
): Date | null {
  if (!retentionEnabled(retentionDays)) return null;
  return new Date(now.getTime() - retentionDays * MS_PER_DAY);
}

/**
 * Whether a single conversation, last active at `lastActivityAt`, is due for
 * purge under `retentionDays` as of `now`. Boundary is exclusive: a
 * conversation exactly `retentionDays` old is retained (only strictly-older
 * data is purged), matching the `< cutoff` DELETE predicate in the service.
 */
export function isConversationDue(
  lastActivityAt: Date,
  retentionDays: number | null | undefined,
  now: Date,
): boolean {
  const cutoff = retentionCutoff(retentionDays, now);
  if (cutoff === null) return false;
  return lastActivityAt.getTime() < cutoff.getTime();
}
