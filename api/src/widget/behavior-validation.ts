import { BadRequestException } from '@nestjs/common';

/**
 * Structural validation + sanitization for the two widget "behavior" surfaces:
 *
 *  - Page-targeting rules (#11): ordered show/hide rules matched against the
 *    host page URL via glob or regex patterns.
 *  - Proactive triggers (#12): after-N-seconds / scroll-depth / exit-intent
 *    rules that tell the embed client when to auto-open the widget.
 *
 * Both are authored by editors through the dashboard API and served read-only
 * on the public widget config endpoint, so every field is bounded and coerced
 * to a known shape here before it is ever persisted. Untrusted extra keys are
 * dropped rather than stored, so the public payload never leaks arbitrary
 * editor-supplied JSON.
 */

export type TargetingMode = 'show' | 'hide';
export type TargetingMatchType = 'glob' | 'regex';

export interface TargetingRule {
  mode: TargetingMode;
  matchType: TargetingMatchType;
  pattern: string;
}

export interface TargetingConfig {
  /**
   * When no rule matches a page, this decides the default visibility.
   * `true` (the default) means the widget shows unless a `hide` rule matches;
   * `false` means it stays hidden unless a `show` rule matches.
   */
  defaultShow: boolean;
  rules: TargetingRule[];
}

export interface TriggersConfig {
  /** Auto-open after the visitor has been on the page this many seconds. */
  afterSeconds: number | null;
  /** Auto-open once the visitor scrolls at least this % (0-100) down the page. */
  scrollDepth: number | null;
  /** Auto-open when the pointer leaves the viewport (desktop exit-intent). */
  exitIntent: boolean;
}

const MAX_RULES = 50;
const MAX_PATTERN_LENGTH = 2_048;
const MAX_TRIGGER_SECONDS = 86_400; // 24h — anything larger is a mistake.

export const DEFAULT_TARGETING: TargetingConfig = {
  defaultShow: true,
  rules: [],
};

export const DEFAULT_TRIGGERS: TriggersConfig = {
  afterSeconds: null,
  scrollDepth: null,
  exitIntent: false,
};

/**
 * True for any non-null, non-array object. We deliberately accept class
 * instances (e.g. validated DTOs handed over by the controller) as well as
 * plain objects — sanitize reads only known, explicitly-whitelisted properties
 * off the value, so the prototype is irrelevant. Arrays and primitives are
 * rejected because the callers expect a keyed record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Rejects patterns that would make the RegExp engine catastrophically backtrack or never compile. */
function assertValidRegex(pattern: string): void {
  try {
    new RegExp(pattern);
  } catch {
    throw new BadRequestException(
      `Invalid targeting rule: "${pattern}" is not a valid regular expression`,
    );
  }
}

/**
 * Validates + normalizes a page-targeting config, returning a fresh object
 * containing ONLY the known fields. Throws `BadRequestException` on any
 * structural violation.
 */
export function sanitizeTargeting(input: unknown): TargetingConfig {
  if (input === undefined || input === null) return { ...DEFAULT_TARGETING };
  if (!isRecord(input)) {
    throw new BadRequestException('Invalid targeting: must be an object');
  }

  const defaultShow =
    input.defaultShow === undefined ? true : Boolean(input.defaultShow);

  const rawRules = input.rules ?? [];
  if (!Array.isArray(rawRules)) {
    throw new BadRequestException('Invalid targeting: rules must be an array');
  }
  if (rawRules.length > MAX_RULES) {
    throw new BadRequestException(
      `Too many targeting rules (max ${MAX_RULES})`,
    );
  }

  const rules: TargetingRule[] = rawRules.map((raw, i) => {
    if (!isRecord(raw)) {
      throw new BadRequestException(`Targeting rule ${i} must be an object`);
    }
    if (raw.mode !== 'show' && raw.mode !== 'hide') {
      throw new BadRequestException(
        `Targeting rule ${i}: mode must be "show" or "hide"`,
      );
    }
    if (raw.matchType !== 'glob' && raw.matchType !== 'regex') {
      throw new BadRequestException(
        `Targeting rule ${i}: matchType must be "glob" or "regex"`,
      );
    }
    if (typeof raw.pattern !== 'string' || raw.pattern.length === 0) {
      throw new BadRequestException(
        `Targeting rule ${i}: pattern must be a non-empty string`,
      );
    }
    if (raw.pattern.length > MAX_PATTERN_LENGTH) {
      throw new BadRequestException(
        `Targeting rule ${i}: pattern too long (max ${MAX_PATTERN_LENGTH})`,
      );
    }
    if (raw.matchType === 'regex') {
      assertValidRegex(raw.pattern);
    }
    return {
      mode: raw.mode,
      matchType: raw.matchType,
      pattern: raw.pattern,
    };
  });

  return { defaultShow, rules };
}

function sanitizeOptionalNumber(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BadRequestException(`Invalid trigger: ${field} must be a number`);
  }
  if (value < min || value > max) {
    throw new BadRequestException(
      `Invalid trigger: ${field} must be between ${min} and ${max}`,
    );
  }
  return value;
}

/**
 * Validates + normalizes a proactive-triggers config, returning a fresh object
 * containing ONLY the known fields. Throws `BadRequestException` on violation.
 */
export function sanitizeTriggers(input: unknown): TriggersConfig {
  if (input === undefined || input === null) return { ...DEFAULT_TRIGGERS };
  if (!isRecord(input)) {
    throw new BadRequestException('Invalid triggers: must be an object');
  }

  const afterSeconds = sanitizeOptionalNumber(
    input.afterSeconds,
    'afterSeconds',
    0,
    MAX_TRIGGER_SECONDS,
  );
  const scrollDepth = sanitizeOptionalNumber(
    input.scrollDepth,
    'scrollDepth',
    0,
    100,
  );
  const exitIntent =
    input.exitIntent === undefined ? false : Boolean(input.exitIntent);

  return { afterSeconds, scrollDepth, exitIntent };
}
