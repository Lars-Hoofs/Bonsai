import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiKeysService, ResolvedWidgetKey } from '../apikeys/apikeys.service';

interface WidgetKeyedRequest {
  headers: Record<string, string | undefined>;
  query: Record<string, string | undefined>;
  widgetKey?: ResolvedWidgetKey;
}

/**
 * Guards the public (anonymous) chat widget conversation routes. Reads the
 * public_widget API key from `x-bonsai-key` (or `?key=`, matching the
 * existing widget-config convention), resolves it via
 * `ApiKeysService.resolveWidgetKey` (origin-checked), and attaches the
 * resolved `{ tenantId, projectId, schemaName }` onto the request as
 * `widgetKey` so route handlers derive tenant/project scoping ONLY from this
 * server-resolved value — never from any client-supplied tenantId/projectId.
 */
@Injectable()
export class PublicWidgetGuard implements CanActivate {
  constructor(private readonly apiKeys: ApiKeysService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<WidgetKeyedRequest>();
    const key = req.headers['x-bonsai-key'] ?? req.query.key;
    if (!key) throw new UnauthorizedException('Missing widget key');
    const origin = req.headers.origin;
    const resolved = await this.apiKeys.resolveWidgetKey(key, origin);
    if (!resolved) {
      throw new UnauthorizedException('Invalid widget key or origin');
    }
    req.widgetKey = resolved;
    return true;
  }
}
