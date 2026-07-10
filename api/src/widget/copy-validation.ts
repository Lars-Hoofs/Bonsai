import { BadRequestException } from '@nestjs/common';

/**
 * Structural/size guards for the multi-language widget copy blob before it is
 * persisted. The copy is a JSON map of locale -> copy object, where each copy
 * object is a flat map of string keys (e.g. `welcome`, `placeholder`,
 * `sendLabel`) to string values. This bounds the stored blob's size, the
 * number of locales/keys, and validates locale tags — it does NOT sanitize
 * string content. The widget embed client must still escape any copy string
 * fields at render time; that is a frontend concern and out of scope here.
 */

const MAX_SERIALIZED_LENGTH = 65_536;
const MAX_LOCALES = 50;
const MAX_KEYS_PER_LOCALE = 200;
const MAX_VALUE_LENGTH = 4_000;

// BCP-47-ish: `en`, `en-US`, `zh-Hant`, `pt-BR`. Deliberately permissive on
// subtags but bounded in length so it can be used as a JSON key safely.
const LOCALE_RE = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/;

/** True for a plain `{}`-style object — excludes arrays, null, class instances. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Validates that `locale` is a well-formed, length-bounded language tag.
 * Returns the normalized (lowercased) tag. Throws `BadRequestException` on a
 * malformed tag.
 */
export function normalizeLocale(locale: string): string {
  if (typeof locale !== 'string' || !LOCALE_RE.test(locale)) {
    throw new BadRequestException(`Invalid locale: ${String(locale)}`);
  }
  return locale.toLowerCase();
}

/**
 * Validates a multi-language copy payload before it is persisted: must be a
 * plain object mapping valid locale tags to flat objects of string->string.
 * Bounded in serialized size, locale count, per-locale key count, and value
 * length. Returns the payload with locale keys normalized (lowercased).
 * Throws `BadRequestException` with a clear message on any violation.
 */
export function assertCopyShape(
  copy: unknown,
): Record<string, Record<string, string>> {
  if (!isPlainObject(copy)) {
    throw new BadRequestException('Invalid copy: must be a plain object');
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(copy);
  } catch {
    throw new BadRequestException('Invalid copy: must be a plain object');
  }
  if (serialized.length > MAX_SERIALIZED_LENGTH) {
    throw new BadRequestException('Copy too large');
  }

  const locales = Object.keys(copy);
  if (locales.length > MAX_LOCALES) {
    throw new BadRequestException('Too many locales');
  }

  const out: Record<string, Record<string, string>> = {};
  for (const locale of locales) {
    const normalized = normalizeLocale(locale);
    if (out[normalized]) {
      throw new BadRequestException(`Duplicate locale: ${normalized}`);
    }
    const entry = copy[locale];
    if (!isPlainObject(entry)) {
      throw new BadRequestException(
        `Invalid copy for locale ${locale}: must be a plain object`,
      );
    }
    const keys = Object.keys(entry);
    if (keys.length > MAX_KEYS_PER_LOCALE) {
      throw new BadRequestException(`Too many keys for locale ${locale}`);
    }
    const normalizedEntry: Record<string, string> = {};
    for (const key of keys) {
      const value = entry[key];
      if (typeof value !== 'string') {
        throw new BadRequestException(
          `Invalid copy value for ${locale}.${key}: must be a string`,
        );
      }
      if (value.length > MAX_VALUE_LENGTH) {
        throw new BadRequestException(
          `Copy value for ${locale}.${key} too long`,
        );
      }
      normalizedEntry[key] = value;
    }
    out[normalized] = normalizedEntry;
  }

  return out;
}
