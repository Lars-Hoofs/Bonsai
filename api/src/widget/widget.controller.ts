import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import { Tenant } from '../auth/auth.types';
import type { TenantRef } from '../auth/auth.types';
import { RequireRole } from '../auth/roles.decorator';
import { SaveThemeDto } from './dto';
import { WidgetService } from './widget.service';

@Controller('tenants/:tenantId/projects/:projectId/widget')
export class WidgetController {
  constructor(private readonly widget: WidgetService) {}

  @Get('theme')
  @RequireRole('viewer')
  get(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.widget.get(tenant.schemaName, projectId);
  }

  @Put('theme')
  @RequireRole('editor')
  save(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: SaveThemeDto,
  ) {
    return this.widget.saveDraft(tenant.schemaName, projectId, dto.theme);
  }

  @Post('theme/publish')
  @RequireRole('editor')
  publish(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.widget.publish(tenant.schemaName, projectId);
  }

  @Get('theme/published')
  @RequireRole('viewer')
  published(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.widget.getPublished(tenant.schemaName, projectId);
  }
}
