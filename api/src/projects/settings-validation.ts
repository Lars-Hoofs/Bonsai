import { BadRequestException } from '@nestjs/common';

/**
 * `projects.settings` is a free-form jsonb blob (see `ProjectsService`/
 * `Project.settings`) that several other services read tolerant,
 * best-effort values out of (see `AnswerService.loadProject` for
 * `confidenceThreshold`, `ConversationsService`'s
 * `readBusinessHoursSettings` for `businessHours`/`afterHoursMessage`).
 *
 * This module is the write-side counterpart: it defines the known/managed
 * key set for the settings-management API (GET/PATCH
 * `.../projects/:projectId/settings`) and validates a partial update
 * before it is merged into the stored jsonb. Unknown keys are rejected so
 * the managed surface stays well-defined; keys not yet read by any service
 * (the per-project feature-toggle booleans, `retrievalWindow`,
 * `verificationMode`) are still accepted and stored for future use, per
 * the feature spec.
 */

export const KNOWN_SETTINGS_KEYS = [
  'confidenceThreshold',
  'verificationMode',
  'businessHours',
  'afterHoursMessage',
  'selfCheckEnabled',
  'multiQueryEnabled',
  'toolCallingEnabled',
  'followupSuggestionsEnabled',
  'dedupEnabled',
  'retrievalWindow',
  'profanityFilter',
] as const;

export type KnownSettingsKey = (typeof KNOWN_SETTINGS_KEYS)[number];

const VERIFICATION_MODES = ['self-check', 'claim-nli'] as const;

const PROFANITY_ACTIONS = ['warn', 'block', 'flag'] as const;

/**
 * Validates the per-project profanity/abuse filter config (#31):
 * `{ enabled: boolean, action: 'warn'|'block'|'flag', extraTerms?: string[],
 * allowTerms?: string[] }`. The runtime reader (`readProfanityConfig`) is
 * tolerant of garbage, but this write-side gate rejects malformed input so
 * the stored shape stays well-defined.
 */
function assertProfanityFilter(value: unknown): void {
  if (!isPlainObject(value)) {
    throw new BadRequestException('Invalid profanityFilter: must be an object');
  }
  const { enabled, action, extraTerms, allowTerms } = value as {
    enabled?: unknown;
    action?: unknown;
    extraTerms?: unknown;
    allowTerms?: unknown;
  };
  if (typeof enabled !== 'boolean') {
    throw new BadRequestException(
      'Invalid profanityFilter.enabled: must be a boolean',
    );
  }
  if (
    typeof action !== 'string' ||
    !(PROFANITY_ACTIONS as readonly string[]).includes(action)
  ) {
    throw new BadRequestException(
      `Invalid profanityFilter.action: must be one of ${PROFANITY_ACTIONS.join(', ')}`,
    );
  }
  for (const listKey of ['extraTerms', 'allowTerms'] as const) {
    const list = listKey === 'extraTerms' ? extraTerms : allowTerms;
    if (list === undefined) continue;
    if (
      !Array.isArray(list) ||
      list.some((t) => typeof t !== 'string' || t.length === 0)
    ) {
      throw new BadRequestException(
        `Invalid profanityFilter.${listKey}: must be an array of non-empty strings`,
      );
    }
  }
}

const BOOLEAN_KEYS: ReadonlySet<KnownSettingsKey> = new Set([
  'selfCheckEnabled',
  'multiQueryEnabled',
  'toolCallingEnabled',
  'followupSuggestionsEnabled',
  'dedupEnabled',
]);

/** True for a plain `{}`-style object — excludes arrays, null, class instances. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertBusinessHours(value: unknown): void {
  if (!isPlainObject(value)) {
    throw new BadRequestException(
      'Invalid businessHours: must be an object with timezone and intervals',
    );
  }
  const { timezone, intervals } = value as {
    timezone?: unknown;
    intervals?: unknown;
  };
  if (typeof timezone !== 'string' || timezone.length === 0) {
    throw new BadRequestException(
      'Invalid businessHours.timezone: must be a non-empty string',
    );
  }
  try {
    // Validates the IANA timezone name without any new dependency.
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw new BadRequestException(
      `Invalid businessHours.timezone: unknown timezone '${timezone}'`,
    );
  }
  if (!Array.isArray(intervals)) {
    throw new BadRequestException(
      'Invalid businessHours.intervals: must be an array',
    );
  }
  const timeRe = /^([01]\d|2[0-3]):([0-5]\d)$/;
  intervals.forEach((interval, i) => {
    if (!isPlainObject(interval)) {
      throw new BadRequestException(
        `Invalid businessHours.intervals[${i}]: must be an object`,
      );
    }
    const { day, open, close } = interval as {
      day?: unknown;
      open?: unknown;
      close?: unknown;
    };
    if (
      typeof day !== 'number' ||
      !Number.isInteger(day) ||
      day < 1 ||
      day > 7
    ) {
      throw new BadRequestException(
        `Invalid businessHours.intervals[${i}].day: must be an integer 1..7 (ISO weekday)`,
      );
    }
    if (typeof open !== 'string' || !timeRe.test(open)) {
      throw new BadRequestException(
        `Invalid businessHours.intervals[${i}].open: must be 'HH:MM'`,
      );
    }
    if (typeof close !== 'string' || !timeRe.test(close)) {
      throw new BadRequestException(
        `Invalid businessHours.intervals[${i}].close: must be 'HH:MM'`,
      );
    }
  });
}

/**
 * Validates a partial settings-update payload against the known key set,
 * throwing `BadRequestException` on the first violation. Does not mutate
 * `input`.
 */
export function assertSettingsPatchShape(
  input: unknown,
): asserts input is Partial<Record<KnownSettingsKey, unknown>> {
  if (!isPlainObject(input)) {
    throw new BadRequestException('Settings update must be a plain object');
  }

  for (const key of Object.keys(input)) {
    if (!(KNOWN_SETTINGS_KEYS as readonly string[]).includes(key)) {
      throw new BadRequestException(`Unknown settings key: ${key}`);
    }
  }

  if ('confidenceThreshold' in input) {
    const v = input.confidenceThreshold;
    if (typeof v !== 'number' || Number.isNaN(v) || v < 0 || v > 1) {
      throw new BadRequestException(
        'Invalid confidenceThreshold: must be a number between 0 and 1',
      );
    }
  }

  if ('verificationMode' in input) {
    const v = input.verificationMode;
    if (
      typeof v !== 'string' ||
      !(VERIFICATION_MODES as readonly string[]).includes(v)
    ) {
      throw new BadRequestException(
        `Invalid verificationMode: must be one of ${VERIFICATION_MODES.join(', ')}`,
      );
    }
  }

  if ('businessHours' in input) {
    assertBusinessHours(input.businessHours);
  }

  if ('profanityFilter' in input) {
    assertProfanityFilter(input.profanityFilter);
  }

  if ('afterHoursMessage' in input) {
    const v = input.afterHoursMessage;
    if (typeof v !== 'string') {
      throw new BadRequestException(
        'Invalid afterHoursMessage: must be a string',
      );
    }
  }

  if ('retrievalWindow' in input) {
    const v = input.retrievalWindow;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
      throw new BadRequestException(
        'Invalid retrievalWindow: must be an integer >= 0',
      );
    }
  }

  for (const key of BOOLEAN_KEYS) {
    if (key in input && typeof input[key] !== 'boolean') {
      throw new BadRequestException(`Invalid ${key}: must be a boolean`);
    }
  }
}
