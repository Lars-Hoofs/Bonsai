import {
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser, Tenant } from '../auth/auth.types';
import type { AuthUser, TenantRef } from '../auth/auth.types';
import { RequireRole } from '../auth/roles.decorator';
import { SubjectQueryDto } from './dto';
import { GdprService, type ErasureResult } from './gdpr.service';
import type { ExportBundle } from './export-bundle';

/**
 * Admin-only GDPR subject-rights endpoints (#47), scoped to a single
 * (tenant, project). Export streams a downloadable JSON bundle of all
 * personal data tied to a visitor; erasure irreversibly deletes it. Both are
 * gated on the `admin` role by the class-level `@RequireRole` (least
 * privilege for a destructive/sensitive operation).
 */
@Controller('tenants/:tenantId/projects/:projectId/gdpr')
@RequireRole('admin')
export class GdprController {
  constructor(private readonly gdpr: GdprService) {}

  @Get('export')
  async export(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query() query: SubjectQueryDto,
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ExportBundle> {
    const bundle = await this.gdpr.exportSubject(
      tenant,
      projectId,
      query.visitorId,
      user.id,
    );
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="gdpr-export-${projectId}.json"`,
    );
    return bundle;
  }

  @Delete()
  erase(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query() query: SubjectQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<ErasureResult> {
    return this.gdpr.eraseSubject(tenant, projectId, query.visitorId, user.id);
  }
}
