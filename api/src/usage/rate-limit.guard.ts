import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  mixin,
  Type,
} from '@nestjs/common';
import { APP_CONFIG } from '../config/config';
import type { AppConfig } from '../config/config';
import type { TenantRef } from '../auth/auth.types';
import type { ResolvedWidgetKey } from '../apikeys/apikeys.service';
import { RateLimiterService } from './rate-limiter.service';
import { MetricsService } from '../metrics/metrics.service';

interface RateLimitedRequest {
  tenant?: TenantRef;
  widgetKey?: ResolvedWidgetKey;
  route?: { path?: string };
  ip?: string;
  socket?: { remoteAddress?: string };
}

/**
 * Per-caller rate limit guard. Runs as a route-level guard (or with an
 * explicit `limit`/`windowMs` override for stricter public routes).
 *
 * Key derivation, in priority order — never a single shared literal, so
 * unkeyed/anonymous callers don't all share one global bucket:
 *  1. `req.tenant.id` — authenticated tenant routes (MembershipGuard has run).
 *  2. `req.widgetKey.projectId` + client IP — public widget routes gated by
 *     `PublicWidgetGuard` (must run before this guard so `widgetKey` is set).
 *  3. Client IP alone — last resort for routes with no resolved identity yet
 *     (e.g. widget config, which authenticates the key inside the handler).
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  /** Optional stricter override; defaults to the tenant-route configured limit. */
  protected readonly limit?: number;
  protected readonly windowMs?: number;

  constructor(
    protected readonly limiter: RateLimiterService,
    @Inject(APP_CONFIG) protected readonly cfg: AppConfig,
    protected readonly metrics: MetricsService,
  ) {}

  /**
   * Resolves the effective per-minute limit for this request. Overridable by
   * subclasses (e.g. `rateLimitGuardFromConfig`) that need to read a
   * config-driven limit at request time rather than a `limit` field baked in
   * at class-definition time.
   */
  protected getLimit(): number {
    return this.limit ?? this.cfg.rateLimitPerMinute;
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<RateLimitedRequest>();
    const route = req.route?.path ?? 'unknown';
    const callerKey = this.callerKey(req);
    const limit = this.getLimit();
    const windowMs = this.windowMs ?? 60_000;
    const allowed = await this.limiter.allow(
      `${callerKey}:${route}`,
      limit,
      windowMs,
      Date.now(),
    );
    if (!allowed) {
      this.metrics.rateLimitBlockedTotal.inc();
      throw new HttpException(
        'Rate limit exceeded, please slow down.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }

  private callerKey(req: RateLimitedRequest): string {
    if (req.tenant?.id) return `tenant:${req.tenant.id}`;
    const ip = this.clientIp(req);
    if (req.widgetKey?.projectId) {
      return `project:${req.widgetKey.projectId}:ip:${ip}`;
    }
    return `ip:${ip}`;
  }

  private clientIp(req: RateLimitedRequest): string {
    return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
  }
}

/**
 * Builds a `RateLimitGuard` variant with a fixed limit/window, for public
 * routes that need a stricter (or looser) throttle than the tenant-route
 * default `RATE_LIMIT_PER_MINUTE`. Still resolves through Nest DI (via
 * `mixin`), so it shares the same Redis-backed `RateLimiterService` and key
 * derivation as the base guard.
 */
export function rateLimitGuard(
  limit: number,
  windowMs = 60_000,
): Type<CanActivate> {
  @Injectable()
  class ScopedRateLimitGuard extends RateLimitGuard {
    protected readonly limit = limit;
    protected readonly windowMs = windowMs;
  }
  return mixin(ScopedRateLimitGuard);
}

/**
 * Builds a `RateLimitGuard` variant whose limit is read from `AppConfig` at
 * request time (via the `cfg` this class already has injected), rather than
 * a literal baked in at module-load time. Use this for public-route limits
 * that must be operator-tunable via env vars (e.g. `WIDGET_CONFIG_RATE_PER_MIN`,
 * `CONVERSATION_START_RATE_PER_MIN`) without a code change/redeploy.
 */
export function rateLimitGuardFromConfig(
  selectLimit: (cfg: AppConfig) => number,
  windowMs = 60_000,
): Type<CanActivate> {
  @Injectable()
  class ConfiguredRateLimitGuard extends RateLimitGuard {
    protected readonly windowMs = windowMs;
    protected override getLimit(): number {
      return selectLimit(this.cfg);
    }
  }
  return mixin(ConfiguredRateLimitGuard);
}
