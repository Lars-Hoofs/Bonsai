import {
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../auth/public.decorator';
import { APP_CONFIG } from '../config/config';
import type { AppConfig } from '../config/config';
import { MetricsService } from './metrics.service';

/**
 * Self-hosted Prometheus scrape endpoint at `GET /metrics` (excluded from the
 * `v1` prefix, like /health and /docs — see main.ts). Prometheus can't do
 * OIDC, so this route is `@Public()` w.r.t. the OIDC AuthGuard, but it is NOT
 * unauthenticated: it enforces its own bearer-token check so the payload
 * (internal route names, counters) is never publicly world-readable.
 *
 * Gating rules:
 *  - METRICS_TOKEN set: requires `Authorization: Bearer <token>` or
 *    `?token=<token>`. Anything else -> 401.
 *  - METRICS_TOKEN unset: allowed only outside production (dev convenience);
 *    in production an unset token hard-disables the endpoint (404), since
 *    there is no way to gate it safely.
 */
@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  @Get()
  @Public()
  async scrape(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Query('token') tokenQuery?: string,
  ): Promise<string> {
    this.authorize(req, tokenQuery);
    const { body, contentType } = await this.metrics.render();
    res.setHeader('Content-Type', contentType);
    return body;
  }

  private authorize(req: Request, tokenQuery?: string): void {
    const configured = this.cfg.metricsToken;
    if (!configured) {
      // No token configured: only ever expose this outside production.
      if (this.cfg.nodeEnv === 'production') {
        throw new NotFoundException();
      }
      return;
    }
    const header = req.headers.authorization;
    const bearer = header?.startsWith('Bearer ')
      ? header.slice('Bearer '.length)
      : undefined;
    const supplied = bearer ?? tokenQuery;
    if (supplied !== configured) {
      throw new ForbiddenException('Invalid or missing metrics token');
    }
  }
}
