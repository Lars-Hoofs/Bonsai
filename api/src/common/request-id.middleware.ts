import { randomUUID } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';

export function requestIdMiddleware(
  req: Request & { requestId?: string },
  res: Response,
  next: NextFunction,
): void {
  const header = req.headers['x-request-id'];
  const id =
    typeof header === 'string' && header.length > 0 ? header : randomUUID();
  req.requestId = id;
  res.setHeader('x-request-id', id);
  next();
}
