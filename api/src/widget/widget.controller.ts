import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import { CurrentUser, Tenant } from '../auth/auth.types';
import type { AuthUser, TenantRef } from '../auth/auth.types';
import { RequireRole } from '../auth/roles.decorator';
import {
  ApplyPresetDto,
  ImportThemeDto,
  SaveTargetingDto,
  SaveThemeDto,
  SaveTriggersDto,
} from './dto';
import { PreviewTokenService } from './preview-token.service';
import { WidgetService } from './widget.service';

@Controller('tenants/:tenantId/projects/:projectId/widget')
export class WidgetController {
  constructor(
    private readonly widget: WidgetService,
    private readonly previewTokens: PreviewTokenService,
  ) {}

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
    @CurrentUser() user: AuthUser,
  ) {
    return this.widget.publish(tenant.schemaName, projectId, {
      tenantId: tenant.id,
      actorUserId: user.id,
    });
  }

  @Get('theme/published')
  @RequireRole('viewer')
  published(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.widget.getPublished(tenant.schemaName, projectId);
  }

  @Get('theme/presets')
  @RequireRole('viewer')
  presets() {
    return this.widget.listPresets();
  }

  @Post('theme/apply-preset')
  @RequireRole('editor')
  applyPreset(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: ApplyPresetDto,
  ) {
    return this.widget.applyPreset(tenant.schemaName, projectId, dto.preset);
  }

  @Get('theme/export')
  @RequireRole('viewer')
  export(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.widget.exportTheme(tenant.schemaName, projectId);
  }

  @Post('theme/import')
  @RequireRole('editor')
  import(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: ImportThemeDto,
  ) {
    return this.widget.importTheme(tenant.schemaName, projectId, dto.theme);
  }

  @Get('theme/contrast')
  @RequireRole('viewer')
  contrast(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.widget.contrastReport(tenant.schemaName, projectId);
  }

  /**
   * Issues a short-lived (1h) signed token for the shareable draft preview
   * link. The token itself is opaque and unauthenticated at the public
   * endpoint (see WidgetPublicController.preview) — anyone holding the link
   * can view the draft, which is the intended "share this preview with a
   * stakeholder" behavior. It grants read access to the draft ONLY, never
   * write access.
   */
  @Post('theme/preview-token')
  @RequireRole('editor')
  async createPreviewToken(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    const token = await this.previewTokens.issue(tenant.schemaName, projectId);
    return { token };
  }

  // --- Page-targeting rules (#11) ---

  @Put('targeting')
  @RequireRole('editor')
  saveTargeting(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: SaveTargetingDto,
  ) {
    return this.widget.saveTargeting(tenant.schemaName, projectId, dto);
  }

  // --- Proactive triggers (#12) ---

  @Put('triggers')
  @RequireRole('editor')
  saveTriggers(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: SaveTriggersDto,
  ) {
    return this.widget.saveTriggers(tenant.schemaName, projectId, dto);
  }
}
