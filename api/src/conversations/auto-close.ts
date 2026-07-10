/**
 * Auto-close idle conversations (#40): pure, dependency-free helpers the
 * scheduled reaper (ConversationReaperService) uses to decide, per project,
 * whether auto-close is enabled and after how many idle minutes a
 * conversation should be closed.
 *
 * `projects.settings` is a free-form, user/agent-editable jsonb blob (see
 * ProjectsService / settings-validation.ts), so — exactly like
 * `readBusinessHoursSettings` — these readers tolerate any missing/garbage
 * shape and never trust its structure.
 */

export interface AutoCloseConfig {
  /** True when this project has opted into idle auto-close. */
  enabled: boolean;
  /** Minutes of inactivity after which an open conversation is closed. */
  idleMinutes: number;
}

/**
 * Resolves a project's effective auto-close config from its settings blob.
 * `autoCloseEnabled` must be an explicit boolean to opt in (missing/garbage
 * = disabled). `autoCloseIdleMinutes` must be a positive integer to take
 * effect; otherwise `defaultIdleMinutes` (the reaper's global fallback) is
 * used.
 */
export function readAutoCloseSettings(
  settings: Record<string, unknown>,
  defaultIdleMinutes: number,
): AutoCloseConfig {
  const enabled = settings.autoCloseEnabled === true;
  const raw = settings.autoCloseIdleMinutes;
  const idleMinutes =
    typeof raw === 'number' && Number.isInteger(raw) && raw >= 1
      ? raw
      : defaultIdleMinutes;
  return { enabled, idleMinutes };
}
