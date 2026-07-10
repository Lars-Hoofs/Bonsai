import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { Tenant } from '../auth/auth.types';
import type { TenantRef } from '../auth/auth.types';
import { RequireRole } from '../auth/roles.decorator';
import { CreateHandoverTargetDto } from './dto';
import { NotificationsService } from './notifications.service';

/**
 * Admin-only management of per-project handover notification targets (#38).
 * Mirrors the outbound `webhooks` controller: configuring where handover
 * alerts are delivered is an administrative concern.
 */
@Controller('tenants/:tenantId/projects/:projectId/handover-notifications')
@RequireRole('admin')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Post()
  create(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateHandoverTargetDto,
  ) {
    return this.notifications.create(tenant.schemaName, projectId, dto);
  }

  @Get()
  list(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.notifications.list(tenant.schemaName, projectId);
  }

  @Delete(':targetId')
  async remove(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('targetId', ParseUUIDPipe) targetId: string,
  ): Promise<{ ok: true }> {
    await this.notifications.remove(tenant.schemaName, projectId, targetId);
    return { ok: true };
  }
}
