import { BadRequestException } from '@nestjs/common';
import { isValidHexColor } from './contrast';
import { assertThemeShape } from './theme-validation';

/**
 * Documented widget theme schema.
 *
 * This is the authoritative shape for the widget builder's theme config.
 * It is intentionally a hand-written validating function (rather than a
 * class-validator DTO tree) so it can enforce "reject unknown keys at every
 * level" uniformly, including inside plain nested objects that are not
 * themselves DTO classes — and so the same function can validate a partial
 * PUT payload, a full preset, and an imported export with identical rules.
 *
 * All top-level sections are OPTIONAL: a draft can be edited incrementally
 * (e.g. `PUT { theme: { colors: { primary: '#111' } } }`), and the service
 * layer is responsible for merge/replace semantics — this function only
 * validates whatever shape it is given.
 *
 * `assertThemeShape` (structural size/depth/key-count guard) still runs
 * first and remains the outermost defense-in-depth check.
 */

export const MAX_CUSTOM_CSS_LENGTH = 16_384;
export const MAX_SUGGESTIONS = 20;
export const MAX_SUGGESTION_LENGTH = 200;

const SHADOW_VALUES = ['none', 'small', 'medium', 'large'] as const;
export type ShadowValue = (typeof SHADOW_VALUES)[number];

const LAUNCHER_ICON_MODES = ['gradient', 'custom'] as const;
export type LauncherIconMode = (typeof LAUNCHER_ICON_MODES)[number];

const LAUNCHER_CORNERS = ['br', 'bl', 'tr', 'tl'] as const;
export type LauncherCorner = (typeof LAUNCHER_CORNERS)[number];

const OPENING_ANIMATIONS = ['fade', 'slide', 'bounce', 'none'] as const;
export type OpeningAnimationType = (typeof OPENING_ANIMATIONS)[number];

function fail(message: string): never {
  throw new BadRequestException(`Invalid theme: ${message}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Throws if `obj` has any key not present in `allowed`. */
function assertKnownKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      fail(`unknown key "${key}" in ${path}`);
    }
  }
}

function assertHex(value: unknown, path: string): void {
  if (!isValidHexColor(value)) {
    fail(
      `${path} must be a hex color (e.g. "#7C3AED"), got ${JSON.stringify(value)}`,
    );
  }
}

function assertOptionalHex(value: unknown, path: string): void {
  if (value === undefined) return;
  assertHex(value, path);
}

function assertOptionalString(value: unknown, path: string): void {
  if (value === undefined) return;
  if (typeof value !== 'string') fail(`${path} must be a string`);
}

function assertOptionalNumber(
  value: unknown,
  path: string,
  opts: { min?: number; max?: number } = {},
): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || Number.isNaN(value)) {
    fail(`${path} must be a number`);
  }
  if (opts.min !== undefined && value < opts.min) {
    fail(`${path} must be >= ${opts.min}`);
  }
  if (opts.max !== undefined && value > opts.max) {
    fail(`${path} must be <= ${opts.max}`);
  }
}

function assertOptionalEnum<T extends string>(
  value: unknown,
  values: readonly T[],
  path: string,
): void {
  if (value === undefined) return;
  if (
    typeof value !== 'string' ||
    !(values as readonly string[]).includes(value)
  ) {
    fail(
      `${path} must be one of ${values.join(', ')}, got ${JSON.stringify(value)}`,
    );
  }
}

function assertPlainObjectIfPresent(
  value: unknown,
  path: string,
): value is Record<string, unknown> | undefined {
  if (value === undefined) return true;
  if (!isPlainObject(value)) fail(`${path} must be an object`);
  return true;
}

function validateColors(value: unknown): void {
  if (!assertPlainObjectIfPresent(value, 'colors') || value === undefined)
    return;
  const allowed = [
    'primary',
    'background',
    'text',
    'secondaryText',
    'border',
    'accent',
    'userBubble',
    'botBubble',
  ];
  assertKnownKeys(value, allowed, 'colors');
  for (const key of allowed) {
    assertOptionalHex(value[key], `colors.${key}`);
  }
}

function validateGradient(value: unknown): void {
  if (!assertPlainObjectIfPresent(value, 'gradient') || value === undefined)
    return;
  assertKnownKeys(value, ['from', 'to', 'centerColor', 'angle'], 'gradient');
  assertOptionalHex(value.from, 'gradient.from');
  assertOptionalHex(value.to, 'gradient.to');
  assertOptionalHex(value.centerColor, 'gradient.centerColor');
  assertOptionalNumber(value.angle, 'gradient.angle', { min: 0, max: 360 });
}

function validateTypography(value: unknown): void {
  if (!assertPlainObjectIfPresent(value, 'typography') || value === undefined)
    return;
  assertKnownKeys(
    value,
    ['fontFamily', 'fontSize', 'fontWeight'],
    'typography',
  );
  assertOptionalString(value.fontFamily, 'typography.fontFamily');
  assertOptionalNumber(value.fontSize, 'typography.fontSize', {
    min: 8,
    max: 32,
  });
  assertOptionalNumber(value.fontWeight, 'typography.fontWeight', {
    min: 100,
    max: 900,
  });
}

function validateLauncher(value: unknown): void {
  if (!assertPlainObjectIfPresent(value, 'launcher') || value === undefined)
    return;
  assertKnownKeys(
    value,
    ['iconMode', 'customIconAssetRef', 'size', 'corner', 'offset'],
    'launcher',
  );
  assertOptionalEnum(value.iconMode, LAUNCHER_ICON_MODES, 'launcher.iconMode');
  assertOptionalString(value.customIconAssetRef, 'launcher.customIconAssetRef');
  if (value.iconMode === 'custom' && value.customIconAssetRef === undefined) {
    fail('launcher.customIconAssetRef is required when iconMode is "custom"');
  }
  assertOptionalNumber(value.size, 'launcher.size', { min: 32, max: 120 });
  assertOptionalEnum(value.corner, LAUNCHER_CORNERS, 'launcher.corner');
  if (value.offset !== undefined) {
    if (!isPlainObject(value.offset)) fail('launcher.offset must be an object');
    assertKnownKeys(value.offset, ['x', 'y'], 'launcher.offset');
    assertOptionalNumber(value.offset.x, 'launcher.offset.x', {
      min: 0,
      max: 200,
    });
    assertOptionalNumber(value.offset.y, 'launcher.offset.y', {
      min: 0,
      max: 200,
    });
  }
}

function validateOpeningAnimation(value: unknown): void {
  if (
    !assertPlainObjectIfPresent(value, 'openingAnimation') ||
    value === undefined
  )
    return;
  assertKnownKeys(value, ['type', 'delayMs'], 'openingAnimation');
  assertOptionalEnum(value.type, OPENING_ANIMATIONS, 'openingAnimation.type');
  assertOptionalNumber(value.delayMs, 'openingAnimation.delayMs', {
    min: 0,
    max: 60_000,
  });
}

function validateWelcome(value: unknown): void {
  if (!assertPlainObjectIfPresent(value, 'welcome') || value === undefined)
    return;
  assertKnownKeys(value, ['message', 'suggestions'], 'welcome');
  assertOptionalString(value.message, 'welcome.message');
  if (value.suggestions !== undefined) {
    if (!Array.isArray(value.suggestions)) {
      fail('welcome.suggestions must be an array of strings');
    }
    if (value.suggestions.length > MAX_SUGGESTIONS) {
      fail(`welcome.suggestions must have at most ${MAX_SUGGESTIONS} entries`);
    }
    for (const [i, s] of value.suggestions.entries()) {
      if (typeof s !== 'string') {
        fail(`welcome.suggestions[${i}] must be a string`);
      }
      if (s.length > MAX_SUGGESTION_LENGTH) {
        fail(
          `welcome.suggestions[${i}] must be at most ${MAX_SUGGESTION_LENGTH} chars`,
        );
      }
    }
  }
}

function validateAvatars(value: unknown): void {
  if (!assertPlainObjectIfPresent(value, 'avatars') || value === undefined)
    return;
  assertKnownKeys(value, ['bot', 'agent'], 'avatars');
  assertOptionalString(value.bot, 'avatars.bot');
  assertOptionalString(value.agent, 'avatars.agent');
}

function validateCustomCss(value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== 'string') fail('customCss must be a string');
  if (value.length > MAX_CUSTOM_CSS_LENGTH) {
    fail(`customCss must be at most ${MAX_CUSTOM_CSS_LENGTH} chars`);
  }
}

const TOP_LEVEL_KEYS = [
  'version',
  'colors',
  'gradient',
  'radius',
  'spacing',
  'shadow',
  'typography',
  'launcher',
  'openingAnimation',
  'welcome',
  'avatars',
  'customCss',
  // Legacy/back-compat fields already produced by DEFAULT_WIDGET_THEME and
  // accepted by the original untyped `assertThemeShape`-only validator.
  // Kept permissive here so existing stored themes (window/header/language)
  // continue to round-trip through PUT/publish/import without a forced
  // migration of already-persisted data.
  'window',
  'header',
  'language',
];

/**
 * Validates a theme payload against the documented schema. Throws
 * `BadRequestException` with a descriptive message on any violation.
 * Runs the structural (size/depth/key-count) guard first, then the
 * per-field schema checks. Unknown top-level or nested keys are rejected.
 */
export function validateTheme(theme: unknown): void {
  assertThemeShape(theme);
  const obj = theme as Record<string, unknown>;

  assertKnownKeys(obj, TOP_LEVEL_KEYS, 'theme');
  assertOptionalNumber(obj.version, 'version', { min: 1, max: 1000 });
  validateColors(obj.colors);
  validateGradient(obj.gradient);
  assertOptionalNumber(obj.radius, 'radius', { min: 0, max: 64 });
  assertOptionalNumber(obj.spacing, 'spacing', { min: 0, max: 64 });
  assertOptionalEnum(obj.shadow, SHADOW_VALUES, 'shadow');
  validateTypography(obj.typography);
  validateLauncher(obj.launcher);
  validateOpeningAnimation(obj.openingAnimation);
  validateWelcome(obj.welcome);
  validateAvatars(obj.avatars);
  validateCustomCss(obj.customCss);

  // Legacy fields: accept but don't deep-validate (out of scope for the new
  // schema, kept only for backward compatibility with DEFAULT_WIDGET_THEME
  // and any themes persisted before this schema existed).
  if (obj.window !== undefined && !isPlainObject(obj.window)) {
    fail('window must be an object');
  }
  if (obj.header !== undefined && !isPlainObject(obj.header)) {
    fail('header must be an object');
  }
  if (obj.language !== undefined && typeof obj.language !== 'string') {
    fail('language must be a string');
  }
}

/**
 * Defensively strips sequences that could break out of the isolated
 * shadow-DOM `<style>` element the client renders `customCss` into. This is
 * a belt-and-suspenders backstop, NOT the primary defense — the client is
 * responsible for actually rendering the CSS inside an isolated shadow root
 * and must not trust this function to make the string fully safe for any
 * other context.
 */
export function sanitizeCustomCss(css: string): string {
  return css
    .replace(/<\/style\s*>/gi, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*>/gi, '');
}
