import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { Tenant } from '../auth/auth.types';
import type { TenantRef } from '../auth/auth.types';
import { RequireRole } from '../auth/roles.decorator';
import { AnalyticsService } from './analytics.service';

@Controller('tenants/:tenantId/projects/:projectId/analytics')
@RequireRole('viewer')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get()
  summary(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.analytics.summary(tenant.schemaName, projectId);
  }

  @Get('unanswered')
  unanswered(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.analytics.unanswered(tenant.schemaName, projectId);
  }
}
