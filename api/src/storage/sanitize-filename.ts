const MAX_FILENAME_LENGTH = 200;
const FALLBACK_FILENAME = 'upload';

/**
 * Sanitizes an attacker-controlled filename (e.g. multipart `originalname`)
 * before it is used as part of a storage key. Strips path separators and
 * `..` traversal segments, control characters, and anything outside a safe
 * charset, then caps the length. Pure and deterministic — never touches
 * disk/storage itself.
 */
export function sanitizeFilename(name: string): string {
  const base = name
    // Keep only the final path segment: drop anything an attacker tried to
    // smuggle in as a directory (both POSIX and Windows separators).
    .split(/[/\\]+/)
    .pop();
  const withoutTraversal = (base ?? '').replace(/\.\.+/g, '.');
  const withoutControlChars = withoutTraversal.replace(
    // eslint-disable-next-line no-control-regex -- intentionally stripping control chars
    /[\x00-\x1f\x7f]/g,
    '',
  );
  const safeCharsOnly = withoutControlChars.replace(/[^A-Za-z0-9._-]/g, '_');
  const trimmed = safeCharsOnly.replace(/^[.\s]+/, '').trim();
  const capped = trimmed.slice(0, MAX_FILENAME_LENGTH);
  return capped.length > 0 ? capped : FALLBACK_FILENAME;
}
