import {
  Controller,
  Get,
  Headers,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { ApiKeysService } from '../apikeys/apikeys.service';
import { rateLimitGuardFromConfig } from '../usage/rate-limit.guard';
import { WidgetService } from './widget.service';
import { WidgetCopyService } from './widget-copy.service';

// Per-IP: this endpoint is unauthenticated until the key is resolved inside
// the handler, so it's an easy target for widget-key brute-forcing.
// `WIDGET_CONFIG_RATE_PER_MIN` (default 60/min/IP) is generous for a real
// embedded widget (config is fetched once per page load) while bounding
// guesswork. Read from config (not a literal) so it's tunable via env
// without a code change.
const widgetConfigRateLimitGuard = rateLimitGuardFromConfig(
  (cfg) => cfg.widgetConfigRatePerMin,
);

/**
 * Anonymous widget delivery for the embed script. Authenticated by a
 * public_widget API key (header `x-bonsai-key` or `?key=`), origin-checked
 * against the key's allowed origins. Serves the project's PUBLISHED theme only.
 */
@Controller('widget')
export class WidgetPublicController {
  constructor(
    private readonly apiKeys: ApiKeysService,
    private readonly widget: WidgetService,
    private readonly copy: WidgetCopyService,
  ) {}

  @Get('config')
  @Public()
  @UseGuards(widgetConfigRateLimitGuard)
  async config(
    @Headers('x-bonsai-key') keyHeader: string | undefined,
    @Headers('origin') origin: string | undefined,
    @Headers('accept-language') acceptLanguage: string | undefined,
    @Query('key') keyQuery: string | undefined,
    @Query('locale') locale: string | undefined,
  ) {
    const key = keyHeader ?? keyQuery;
    if (!key) throw new UnauthorizedException('Missing widget key');
    const resolved = await this.apiKeys.resolveWidgetKey(key, origin);
    if (!resolved) {
      throw new UnauthorizedException('Invalid widget key or origin');
    }
    const theme = await this.widget.getPublished(
      resolved.schemaName,
      resolved.projectId,
    );
    // Copy is additive: a project may have a published theme but no published
    // copy yet. Don't fail config delivery in that case — omit `copy`.
    const copy = await this.copy
      .getPublishedCopy(
        resolved.schemaName,
        resolved.projectId,
        locale,
        acceptLanguage,
      )
      .catch(() => null);
    return { ...theme, copy };
  }

  /**
   * Dedicated multi-language copy delivery, mirroring `config`. Serves the
   * PUBLISHED copy for the requested/negotiated locale (explicit `?locale=`
   * takes precedence over the `Accept-Language` header). 404 until first
   * copy publish.
   */
  @Get('copy')
  @Public()
  @UseGuards(widgetConfigRateLimitGuard)
  async widgetCopy(
    @Headers('x-bonsai-key') keyHeader: string | undefined,
    @Headers('origin') origin: string | undefined,
    @Headers('accept-language') acceptLanguage: string | undefined,
    @Query('key') keyQuery: string | undefined,
    @Query('locale') locale: string | undefined,
  ) {
    const key = keyHeader ?? keyQuery;
    if (!key) throw new UnauthorizedException('Missing widget key');
    const resolved = await this.apiKeys.resolveWidgetKey(key, origin);
    if (!resolved) {
      throw new UnauthorizedException('Invalid widget key or origin');
    }
    return this.copy.getPublishedCopy(
      resolved.schemaName,
      resolved.projectId,
      locale,
      acceptLanguage,
    );
  }
}
