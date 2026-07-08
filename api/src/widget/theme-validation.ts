import { BadRequestException } from '@nestjs/common';

/**
 * Structural/size guards for the widget theme JSON blob before it is
 * persisted. This bounds the stored blob's size and shape only — it does
 * NOT sanitize string content. The widget embed client must still
 * sanitize/escape any theme string fields (e.g. custom CSS, labels) at
 * render time; that is a frontend concern and out of scope here.
 */

const MAX_SERIALIZED_LENGTH = 32_768;
const MAX_NESTING_DEPTH = 8;
const MAX_TOTAL_KEYS = 500;

/** True for a plain `{}`-style object — excludes arrays, null, class instances with a non-Object prototype. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Walks the value tree counting total keys and tracking max nesting depth.
 * Arrays are traversed (their elements count toward depth) but their indices
 * do not count as "keys" toward the key-count cap.
 */
function walk(
  value: unknown,
  depth: number,
  state: { totalKeys: number; maxDepth: number },
): void {
  if (depth > state.maxDepth) state.maxDepth = depth;
  if (Array.isArray(value)) {
    for (const item of value) {
      walk(item, depth + 1, state);
    }
    return;
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      state.totalKeys += 1;
      walk(value[key], depth + 1, state);
    }
  }
}

/**
 * Validates a theme payload before it is persisted: must be a plain object,
 * bounded in serialized size, nesting depth, and total key count. Throws
 * `BadRequestException` with a clear message on any violation.
 */
export function assertThemeShape(theme: unknown): void {
  if (!isPlainObject(theme)) {
    throw new BadRequestException('Invalid theme: must be a plain object');
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(theme);
  } catch {
    throw new BadRequestException('Invalid theme: must be a plain object');
  }
  if (serialized.length > MAX_SERIALIZED_LENGTH) {
    throw new BadRequestException('Theme too large');
  }

  const state = { totalKeys: 0, maxDepth: 0 };
  walk(theme, 0, state);

  if (state.maxDepth > MAX_NESTING_DEPTH) {
    throw new BadRequestException('Theme nesting too deep');
  }
  if (state.totalKeys > MAX_TOTAL_KEYS) {
    throw new BadRequestException('Theme has too many keys');
  }
}
