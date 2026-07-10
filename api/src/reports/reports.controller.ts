import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser, Tenant } from '../auth/auth.types';
import type { AuthUser, TenantRef } from '../auth/auth.types';
import { RequireRole } from '../auth/roles.decorator';
import { CreateReportScheduleDto, UpdateReportScheduleDto } from './dto';
import { ReportsService } from './reports.service';
import {
  contentType,
  reportFilename,
  serializeReport,
  type ReportFormat,
} from './report-serialization';

/**
 * Exportable reports (#45). On-demand export (CSV/JSON with a download header)
 * plus CRUD for scheduled generation. Editor-gated throughout: exports and
 * schedules surface project analytics/usage, which is above the viewer bar and
 * matches the least-privilege choice for configuration + data export.
 */
@Controller('tenants/:tenantId/projects/:projectId/reports')
@RequireRole('editor')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  /** On-demand export: streams the current report as CSV or JSON with a
   * Content-Disposition attachment header. `?format=csv|json` (default json). */
  @Get('export')
  async export(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query('format') formatQuery: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const format: ReportFormat = formatQuery === 'csv' ? 'csv' : 'json';
    const data = await this.reports.generate(
      tenant.id,
      tenant.schemaName,
      projectId,
    );
    const body = serializeReport(data, format);
    const filename = reportFilename(projectId, format, data.generatedAt);
    res.setHeader('Content-Type', contentType(format));
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return body;
  }

  @Get('schedules')
  listSchedules(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.reports.list(tenant.schemaName, projectId);
  }

  @Post('schedules')
  createSchedule(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateReportScheduleDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.reports.create(tenant, projectId, dto, user.id);
  }

  @Patch('schedules/:scheduleId')
  updateSchedule(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('scheduleId', ParseUUIDPipe) scheduleId: string,
    @Body() dto: UpdateReportScheduleDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.reports.update(tenant, projectId, scheduleId, dto, user.id);
  }

  @Delete('schedules/:scheduleId')
  async removeSchedule(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('scheduleId', ParseUUIDPipe) scheduleId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<{ ok: true }> {
    await this.reports.remove(tenant, projectId, scheduleId, user.id);
    return { ok: true };
  }
}
