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
import { SaveCopyDto } from './dto';
import { WidgetCopyService } from './widget-copy.service';

/**
 * Editor-facing management of the multi-language widget copy. Mirrors the
 * widget theme surface (`../widget/theme*`): read the draft/published copy,
 * save the draft, and publish it to the live widget.
 */
@Controller('tenants/:tenantId/projects/:projectId/widget/copy')
export class WidgetCopyController {
  constructor(private readonly copy: WidgetCopyService) {}

  @Get()
  @RequireRole('viewer')
  get(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.copy.get(tenant.schemaName, projectId);
  }

  @Put()
  @RequireRole('editor')
  save(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: SaveCopyDto,
  ) {
    return this.copy.saveDraft(tenant.schemaName, projectId, dto);
  }

  @Post('publish')
  @RequireRole('editor')
  publish(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.copy.publish(tenant.schemaName, projectId);
  }
}
