import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';
import { MetricsService } from './metrics.service';

/**
 * Express types `Request.route` as `any` (it's populated by the router at
 * dispatch time), so this narrows it safely rather than trusting an unsafe
 * `any` member access. Returns the matched Nest/Express route pattern (e.g.
 * `/v1/tenants/:id/projects`) — never the raw URL — or `(unmatched)` for
 * requests that never reach a route handler (e.g. an unknown-path 404).
 */
function matchedRoute(req: Request): string {
  const route: unknown = req.route;
  if (
    route &&
    typeof route === 'object' &&
    'path' in route &&
    typeof route.path === 'string'
  ) {
    return (route as { path: string }).path;
  }
  return '(unmatched)';
}

/**
 * Times every HTTP request and records it on `httpRequestDuration`, labelled
 * by method + the *matched Nest route pattern* + status code.
 *
 * Cardinality guardrail: `req.route.path` is the Express route pattern
 * (e.g. `/v1/tenants/:id/projects`), not the raw URL, so path params never
 * create unbounded label series. Falls back to `(unmatched)` for requests
 * that never reach a route handler (e.g. a 404 on an unknown path).
 */
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = ctx.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const method = req.method;
    const start = process.hrtime.bigint();

    const record = (): void => {
      const route = matchedRoute(req);
      const durationSeconds =
        Number(process.hrtime.bigint() - start) / 1_000_000_000;
      this.metrics.httpRequestDuration.observe(
        { method, route, status_code: String(res.statusCode) },
        durationSeconds,
      );
    };

    return next.handle().pipe(
      tap({
        next: () => record(),
        error: () => record(),
      }),
    );
  }
}
