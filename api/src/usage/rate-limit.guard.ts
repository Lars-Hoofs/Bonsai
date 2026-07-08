import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import { APP_CONFIG } from '../config/config';
import type { AppConfig } from '../config/config';
import type { TenantRef } from '../auth/auth.types';
import { RateLimiterService } from './rate-limiter.service';

/**
 * Per-tenant rate limit for expensive (AI) routes. Runs as a route-level guard,
 * so req.tenant is already set by MembershipGuard. Keyed by tenant + route.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly limiter: RateLimiterService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{
      tenant?: TenantRef;
      route?: { path?: string };
    }>();
    const tenantId = req.tenant?.id ?? 'anonymous';
    const route = req.route?.path ?? 'unknown';
    const allowed = this.limiter.allow(
      `${tenantId}:${route}`,
      this.cfg.rateLimitPerMinute,
      60_000,
      Date.now(),
    );
    if (!allowed) {
      throw new HttpException(
        'Rate limit exceeded, please slow down.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
