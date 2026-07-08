import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import Redis from 'ioredis';
import { APP_CONFIG } from '../config/config';
import type { AppConfig } from '../config/config';

/**
 * Fixed-window rate limiter, keyed by e.g. `${tenantId}:${route}`.
 *
 * Backed by Redis (via the same `REDIS_URL` the crawl/BullMQ module uses)
 * when configured, so counters are shared across replicas in a multi-node
 * deployment — a plain in-process `Map` would give each pod its own counter,
 * making the effective limit `limit * replicaCount`.
 *
 * Falls back to an in-process `Map` ONLY when `REDIS_URL` is not configured
 * (dev/test), so the app and its tests still work without Redis.
 *
 * Availability trade-off: if Redis is configured but becomes unreachable at
 * runtime, this fails OPEN (allows the request) and logs a warning, rather
 * than failing closed. Rate limiting here is a guardrail against abuse, not
 * an authorization boundary — the public endpoints it protects are already
 * gated by API keys/origin checks/visitor secrets, so an availability
 * incident in Redis should degrade to "no throttling" rather than taking
 * down otherwise-legitimate traffic.
 */
@Injectable()
export class RateLimiterService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RateLimiterService.name);
  private readonly windows = new Map<
    string,
    { count: number; resetAt: number }
  >();
  private redis?: Redis;

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  onModuleInit(): void {
    if (!this.cfg.redisUrl) return;
    this.redis = new Redis(this.cfg.redisUrl, {
      // Don't let a slow/unreachable Redis stall requests: keep retry
      // internal to ioredis but bound how long a single command can block
      // the request path before we fall back to fail-open behaviour.
      maxRetriesPerRequest: 1,
      lazyConnect: false,
    });
    this.redis.on('error', (err: Error) => {
      this.logger.warn(`Redis rate-limiter connection error: ${err.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis?.quit().catch(() => undefined);
  }

  /** Returns true if the request is allowed, false if the limit is exceeded. */
  async allow(
    key: string,
    limit: number,
    windowMs: number,
    now: number,
  ): Promise<boolean> {
    if (this.redis) {
      try {
        return await this.allowRedis(this.redis, key, limit, windowMs);
      } catch (err) {
        // Fail open: log and let the request through rather than blocking
        // legitimate traffic on a Redis blip (see class doc for rationale).
        this.logger.warn(
          `Redis rate-limiter unavailable, failing open for key "${key}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return true;
      }
    }
    return this.allowInMemory(key, limit, windowMs, now);
  }

  /**
   * Fixed-window counter in Redis: `INCR` the window bucket and set its
   * expiry only on the first increment (count === 1), so the window resets
   * `windowMs` after the first request in that window rather than being
   * pushed back by every subsequent request.
   */
  private async allowRedis(
    redis: Redis,
    key: string,
    limit: number,
    windowMs: number,
  ): Promise<boolean> {
    const redisKey = `ratelimit:${key}`;
    const count = await redis.incr(redisKey);
    if (count === 1) {
      await redis.pexpire(redisKey, windowMs);
    }
    return count <= limit;
  }

  private allowInMemory(
    key: string,
    limit: number,
    windowMs: number,
    now: number,
  ): boolean {
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
