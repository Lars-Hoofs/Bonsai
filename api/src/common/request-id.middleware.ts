import { randomUUID } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';

const ALLOWED_CHARS_RE = /[^A-Za-z0-9._-]/g;
const MAX_LENGTH = 128;

/**
 * Sanitizes a client-supplied x-request-id: cap length and strip any
 * character outside [A-Za-z0-9._-]. This value is reflected back in the
 * response header and typically written to logs, so an unsanitized value
 * could be used for log-forging/CRLF injection or unbounded log lines.
 */
function sanitizeRequestId(value: string): string {
  return value.slice(0, MAX_LENGTH).replace(ALLOWED_CHARS_RE, '');
}

export function requestIdMiddleware(
  req: Request & { requestId?: string },
  res: Response,
  next: NextFunction,
): void {
  const header = req.headers['x-request-id'];
  const sanitized =
    typeof header === 'string' && header.length > 0
      ? sanitizeRequestId(header)
      : '';
  const id = sanitized.length > 0 ? sanitized : randomUUID();
  req.requestId = id;
  res.setHeader('x-request-id', id);
  next();
}
