import { Injectable } from '@nestjs/common';

/**
 * In-memory fixed-window rate limiter (per key). Suitable for a single node;
 * in a multi-replica deployment this is where a Redis-backed limiter would slot
 * in behind the same interface. Keyed by e.g. `${tenantId}:${route}`.
 */
@Injectable()
export class RateLimiterService {
  private readonly windows = new Map<
    string,
    { count: number; resetAt: number }
  >();

  /** Returns true if the request is allowed, false if the limit is exceeded. */
  allow(key: string, limit: number, windowMs: number, now: number): boolean {
    const entry = this.windows.get(key);
    if (!entry || now >= entry.resetAt) {
      this.windows.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (entry.count >= limit) return false;
    entry.count += 1;
    return true;
  }
}
