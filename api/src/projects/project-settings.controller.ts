import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
} from '@nestjs/common';
import { CurrentUser, Tenant } from '../auth/auth.types';
import type { AuthUser, TenantRef } from '../auth/auth.types';
import { RequireRole } from '../auth/roles.decorator';
import { ProjectSettingsService } from './project-settings.service';

@Controller('tenants/:tenantId/projects/:projectId/settings')
export class ProjectSettingsController {
  constructor(private readonly settings: ProjectSettingsService) {}

  @Get()
  @RequireRole('viewer')
  get(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.settings.get(tenant.schemaName, projectId);
  }

  @Patch()
  @RequireRole('editor')
  update(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @CurrentUser() user: AuthUser,
    @Body() patch: Record<string, unknown>,
  ) {
    return this.settings.update(tenant, projectId, user.id, patch);
  }
}
