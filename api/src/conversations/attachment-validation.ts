/**
 * Visitor attachment (#14) type/size policy. Kept pure and separate from the
 * service so the allow-list and the size cap can be unit-tested in isolation
 * and reused by both the multer interceptor (hard byte cap) and the service
 * (defence-in-depth re-check + MIME allow-list).
 *
 * The allow-list is intentionally narrow: common image formats plus PDF and
 * plain text — what a support visitor realistically attaches (a screenshot, a
 * receipt, a photo of a broken product). Executables, archives, HTML/SVG
 * (script-carrying) and office macro formats are deliberately excluded, since
 * these are files an agent will later download and open.
 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MiB

export const ALLOWED_ATTACHMENT_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
];

export interface AttachmentValidationInput {
  contentType: string;
  sizeBytes: number;
}

export interface AttachmentValidationResult {
  ok: boolean;
  /** Human-readable reason when `ok` is false; undefined when valid. */
  reason?: string;
}

/**
 * Validates an uploaded attachment's declared MIME type and byte size against
 * the allow-list and the size cap. Normalizes the content type by l-casing and
 * stripping any `; charset=…`/parameters before matching, since browsers send
 * e.g. `text/plain; charset=utf-8`.
 */
export function validateAttachment(
  input: AttachmentValidationInput,
): AttachmentValidationResult {
  const normalizedType = input.contentType.split(';')[0].trim().toLowerCase();
  if (!ALLOWED_ATTACHMENT_TYPES.includes(normalizedType)) {
    return {
      ok: false,
      reason: `Unsupported file type "${normalizedType || 'unknown'}". Allowed: ${ALLOWED_ATTACHMENT_TYPES.join(', ')}`,
    };
  }
  if (!Number.isFinite(input.sizeBytes) || input.sizeBytes < 0) {
    return { ok: false, reason: 'Invalid file size' };
  }
  if (input.sizeBytes === 0) {
    return { ok: false, reason: 'File is empty' };
  }
  if (input.sizeBytes > MAX_ATTACHMENT_BYTES) {
    return {
      ok: false,
      reason: `File too large (${input.sizeBytes} bytes, max ${MAX_ATTACHMENT_BYTES})`,
    };
  }
  return { ok: true };
}
