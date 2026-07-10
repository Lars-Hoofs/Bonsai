import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { CurrentUser, Tenant } from '../../auth/auth.types';
import type { AuthUser, TenantRef } from '../../auth/auth.types';
import { RequireRole } from '../../auth/roles.decorator';
import { AuditService } from '../../audit/audit.service';
import { CreateEvalCaseDto } from './dto';
import { EvalService } from './eval.service';

@Controller('tenants/:tenantId/projects/:projectId/evals')
export class EvalController {
  constructor(
    private readonly evalService: EvalService,
    private readonly audit: AuditService,
  ) {}

  @Post('cases')
  @RequireRole('editor')
  createCase(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateEvalCaseDto,
  ) {
    return this.evalService.create(tenant.schemaName, projectId, dto);
  }

  @Get('cases')
  @RequireRole('viewer')
  listCases(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.evalService.list(tenant.schemaName, projectId);
  }

  @Delete('cases/:caseId')
  @RequireRole('editor')
  async removeCase(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('caseId', ParseUUIDPipe) caseId: string,
  ) {
    await this.evalService.remove(tenant.schemaName, projectId, caseId);
    return { ok: true };
  }

  @Post('run')
  @RequireRole('editor')
  async run(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @CurrentUser() user: AuthUser,
  ) {
    const summary = await this.evalService.run(tenant.schemaName, projectId);
    await this.audit.record({
      tenantId: tenant.id,
      actorUserId: user.id,
      action: 'eval.run',
      resource: `project:${projectId}`,
      metadata: {
        runId: summary.runId,
        total: summary.total,
        passed: summary.passed,
      },
    });
    return summary;
  }

  @Get('runs')
  @RequireRole('viewer')
  listRuns(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.evalService.listRuns(tenant.schemaName, projectId);
  }
}
