import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Tenant } from '../auth/auth.types';
import type { TenantRef } from '../auth/auth.types';
import { RequireRole } from '../auth/roles.decorator';
import { AuditLogService } from './audit-log.service';
import { AuditLogExportQueryDto, AuditLogQueryDto } from './dto';
import { auditLogRowsToCsv } from './csv';

@Controller('tenants/:tenantId/audit-log')
@RequireRole('admin')
export class AuditLogController {
  constructor(private readonly auditLogService: AuditLogService) {}

  @Get()
  list(@Tenant() tenant: TenantRef, @Query() query: AuditLogQueryDto) {
    return this.auditLogService.list(tenant.id, query, {
      limit: query.limit,
      offset: query.offset,
    });
  }

  @Get('export')
  async export(
    @Tenant() tenant: TenantRef,
    @Query() query: AuditLogExportQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string | object[]> {
    const rows = await this.auditLogService.forExport(tenant.id, query);
    if (query.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="audit-log-${tenant.id}.csv"`,
      );
      return auditLogRowsToCsv(rows);
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return rows;
  }
}
