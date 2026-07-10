import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { CurrentUser, Tenant } from '../auth/auth.types';
import type { AuthUser, TenantRef } from '../auth/auth.types';
import { RequireRole } from '../auth/roles.decorator';
import { ConnectorsService } from './connectors.service';
import { CreateConnectorDto, UpdateConnectorDto } from './dto';

@Controller('tenants/:tenantId/projects/:projectId/connectors')
export class ConnectorsController {
  constructor(private readonly connectors: ConnectorsService) {}

  @Post()
  @RequireRole('editor')
  create(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateConnectorDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.connectors.create(
      tenant.schemaName,
      projectId,
      dto,
      user.id,
      tenant.id,
    );
  }

  @Get()
  list(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.connectors.list(tenant.schemaName, projectId);
  }

  @Get(':connectorId')
  get(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('connectorId', ParseUUIDPipe) connectorId: string,
  ) {
    return this.connectors.get(tenant.schemaName, projectId, connectorId);
  }

  @Patch(':connectorId')
  @RequireRole('editor')
  update(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('connectorId', ParseUUIDPipe) connectorId: string,
    @Body() dto: UpdateConnectorDto,
  ) {
    return this.connectors.update(
      tenant.schemaName,
      projectId,
      connectorId,
      dto,
    );
  }

  @Delete(':connectorId')
  @RequireRole('admin')
  async remove(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('connectorId', ParseUUIDPipe) connectorId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<{ ok: true }> {
    await this.connectors.remove(tenant, projectId, connectorId, user.id);
    return { ok: true };
  }
}
