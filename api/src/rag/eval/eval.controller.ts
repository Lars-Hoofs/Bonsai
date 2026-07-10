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
import { CreateEvalCaseDto, CreateExperimentDto } from './dto';
import { EvalService } from './eval.service';
import { ExperimentService } from './experiment.service';

@Controller('tenants/:tenantId/projects/:projectId/evals')
export class EvalController {
  constructor(
    private readonly evalService: EvalService,
    private readonly experiments: ExperimentService,
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

  // --- A/B experiments (feature #30) ---

  @Post('experiments')
  @RequireRole('editor')
  createExperiment(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateExperimentDto,
  ) {
    return this.experiments.create(tenant.schemaName, projectId, dto);
  }

  @Get('experiments')
  @RequireRole('viewer')
  listExperiments(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.experiments.list(tenant.schemaName, projectId);
  }

  @Get('experiments/:experimentId')
  @RequireRole('viewer')
  getExperiment(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('experimentId', ParseUUIDPipe) experimentId: string,
  ) {
    return this.experiments.get(tenant.schemaName, projectId, experimentId);
  }

  @Delete('experiments/:experimentId')
  @RequireRole('editor')
  async removeExperiment(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('experimentId', ParseUUIDPipe) experimentId: string,
  ) {
    await this.experiments.remove(tenant.schemaName, projectId, experimentId);
    return { ok: true };
  }

  @Post('experiments/:experimentId/run')
  @RequireRole('editor')
  async runExperiment(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('experimentId', ParseUUIDPipe) experimentId: string,
    @CurrentUser() user: AuthUser,
  ) {
    const summary = await this.experiments.run(
      tenant.schemaName,
      projectId,
      experimentId,
    );
    await this.audit.record({
      tenantId: tenant.id,
      actorUserId: user.id,
      action: 'eval.experiment.run',
      resource: `experiment:${experimentId}`,
      metadata: {
        runId: summary.runId,
        total: summary.total,
        bestVariantId: summary.bestVariantId,
        variants: summary.variants.length,
      },
    });
    return summary;
  }

  @Get('experiments/:experimentId/runs')
  @RequireRole('viewer')
  listExperimentRuns(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('experimentId', ParseUUIDPipe) experimentId: string,
  ) {
    return this.experiments.listRuns(
      tenant.schemaName,
      projectId,
      experimentId,
    );
  }
}
