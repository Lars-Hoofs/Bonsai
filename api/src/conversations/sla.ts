/**
 * SLA timers for conversations (#37). Pure, deterministic helpers — no DB, no
 * clock of their own (the caller passes `now`) — so they're trivially
 * unit-testable and safe to reuse from both the service and any future
 * reporting code.
 *
 * An SLA *policy* is read from the free-form `projects.settings` jsonb blob
 * (same tolerant approach as businessHours in conversations.service.ts): two
 * optional durations in minutes. When a project has no policy (or a malformed
 * one), no deadlines are stamped and the conversation can never breach.
 */

/** Minutes granted from conversation start before each SLA milestone is due. */
export interface SlaPolicy {
  /** Deadline for the first human/agent response, in minutes from start. */
  firstResponseMinutes?: number;
  /** Deadline for the conversation to be resolved, in minutes from start. */
  resolutionMinutes?: number;
}

/**
 * The two SLA deadlines for a conversation, as absolute instants. Either may
 * be null when the corresponding policy duration is absent.
 */
export interface SlaDeadlines {
  firstResponseDueAt: Date | null;
  resolutionDueAt: Date | null;
}

/**
 * Read-time SLA state exposed on the conversation API. Deadlines and
 * milestone timestamps are ISO strings (or null); the `*Breached` flags are
 * derived by comparing each deadline against the milestone time — or, if the
 * milestone hasn't happened yet, against `now`.
 */
export interface SlaState {
  firstResponseDueAt: string | null;
  resolutionDueAt: string | null;
  firstRespondedAt: string | null;
  resolvedAt: string | null;
  firstResponseBreached: boolean;
  resolutionBreached: boolean;
}

const MINUTE_MS = 60_000;

function isPositiveFinite(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

/**
 * Narrows the untrusted `projects.settings` jsonb down to an SLA policy,
 * tolerating any missing/garbage shape. Only strictly positive, finite
 * numbers are accepted; anything else is treated as "no policy for that
 * milestone".
 */
export function readSlaPolicy(settings: Record<string, unknown>): SlaPolicy {
  const raw = settings.sla;
  if (!raw || typeof raw !== 'object') return {};
  const obj = raw as Record<string, unknown>;
  const policy: SlaPolicy = {};
  if (isPositiveFinite(obj.firstResponseMinutes)) {
    policy.firstResponseMinutes = obj.firstResponseMinutes;
  }
  if (isPositiveFinite(obj.resolutionMinutes)) {
    policy.resolutionMinutes = obj.resolutionMinutes;
  }
  return policy;
}

/** Computes absolute SLA deadlines from a policy and the conversation start. */
export function computeDeadlines(
  policy: SlaPolicy,
  startedAt: Date,
): SlaDeadlines {
  return {
    firstResponseDueAt: isPositiveFinite(policy.firstResponseMinutes)
      ? new Date(startedAt.getTime() + policy.firstResponseMinutes * MINUTE_MS)
      : null,
    resolutionDueAt: isPositiveFinite(policy.resolutionMinutes)
      ? new Date(startedAt.getTime() + policy.resolutionMinutes * MINUTE_MS)
      : null,
  };
}

/**
 * True when a deadline has been missed: if the milestone was reached, breach
 * means it landed after the deadline; if it hasn't been reached yet, breach
 * means the deadline is already in the past relative to `now`. No deadline =>
 * never breached.
 */
export function isBreached(
  dueAt: Date | null,
  reachedAt: Date | null,
  now: Date,
): boolean {
  if (!dueAt) return false;
  const at = reachedAt ?? now;
  return at.getTime() > dueAt.getTime();
}

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/** Raw SLA columns as stored on a conversation row. */
export interface SlaTimestamps {
  firstResponseDueAt: Date | null;
  resolutionDueAt: Date | null;
  firstRespondedAt: Date | null;
  resolvedAt: Date | null;
}

/**
 * Derives the full read-time SLA state (ISO timestamps + breach flags) from
 * the stored timers, evaluated at `now`.
 */
export function deriveSlaState(t: SlaTimestamps, now: Date): SlaState {
  return {
    firstResponseDueAt: toIso(t.firstResponseDueAt),
    resolutionDueAt: toIso(t.resolutionDueAt),
    firstRespondedAt: toIso(t.firstRespondedAt),
    resolvedAt: toIso(t.resolvedAt),
    firstResponseBreached: isBreached(
      t.firstResponseDueAt,
      t.firstRespondedAt,
      now,
    ),
    resolutionBreached: isBreached(t.resolutionDueAt, t.resolvedAt, now),
  };
}

/** The workflow-status lifecycle values, in order. */
export const WORKFLOW_STATUSES = ['open', 'pending', 'resolved'] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

/**
 * Allowed workflow-status transitions. Deliberately permissive within the
 * lifecycle — an agent can move a ticket in any direction (e.g. reopen a
 * resolved conversation, or park an open one as pending) — but the target
 * must be a real lifecycle value and differ from the current one.
 */
export function isValidTransition(
  from: WorkflowStatus,
  to: WorkflowStatus,
): boolean {
  return from !== to && WORKFLOW_STATUSES.includes(to);
}
