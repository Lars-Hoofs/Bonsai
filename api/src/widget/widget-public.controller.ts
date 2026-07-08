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
import { rateLimitGuard } from '../usage/rate-limit.guard';
import { WidgetService } from './widget.service';

// Per-IP: this endpoint is unauthenticated until the key is resolved inside
// the handler, so it's an easy target for widget-key brute-forcing. 60/min/IP
// is generous for a real embedded widget (config is fetched once per page
// load) while bounding guesswork.
const WIDGET_CONFIG_LIMIT_PER_MINUTE = 60;

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
  ) {}

  @Get('config')
  @Public()
  @UseGuards(rateLimitGuard(WIDGET_CONFIG_LIMIT_PER_MINUTE))
  async config(
    @Headers('x-bonsai-key') keyHeader: string | undefined,
    @Headers('origin') origin: string | undefined,
    @Query('key') keyQuery: string | undefined,
  ) {
    const key = keyHeader ?? keyQuery;
    if (!key) throw new UnauthorizedException('Missing widget key');
    const resolved = await this.apiKeys.resolveWidgetKey(key, origin);
    if (!resolved) {
      throw new UnauthorizedException('Invalid widget key or origin');
    }
    return this.widget.getPublished(resolved.schemaName, resolved.projectId);
  }
}
