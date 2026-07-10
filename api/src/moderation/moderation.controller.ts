import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { Tenant } from '../auth/auth.types';
import type { TenantRef } from '../auth/auth.types';
import { RequireRole } from '../auth/roles.decorator';
import { ModerationEventsQueryDto } from './dto';
import { ModerationService } from './moderation.service';
import type { ModerationEvent } from './moderation.service';

/**
 * Back-office view of profanity/abuse filter events (#31): OIDC +
 * tenant-membership gated (unlike the visitor-facing widget flow that
 * triggers them). Read-only listing of when the filter fired and which
 * policy action was applied, for moderators to review and tune the wordlist.
 */
@Controller('tenants/:tenantId/projects/:projectId/moderation/events')
export class ModerationController {
  constructor(private readonly moderation: ModerationService) {}

  @Get()
  @RequireRole('agent')
  list(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query() query: ModerationEventsQueryDto,
  ): Promise<ModerationEvent[]> {
    return this.moderation.list(tenant.schemaName, projectId, {
      limit: query.limit,
      offset: query.offset,
    });
  }
}
