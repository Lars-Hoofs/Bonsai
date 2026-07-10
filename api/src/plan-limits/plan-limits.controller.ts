import { Controller, Get } from '@nestjs/common';
import { Tenant } from '../auth/auth.types';
import type { TenantRef } from '../auth/auth.types';
import { RequireRole } from '../auth/roles.decorator';
import { PlanLimitsService } from './plan-limits.service';
import type { TenantPlanView } from './plan-limits.service';

@Controller('tenants/:tenantId/plan')
export class PlanLimitsController {
  constructor(private readonly planLimits: PlanLimitsService) {}

  @Get()
  @RequireRole('viewer')
  get(@Tenant() tenant: TenantRef): Promise<TenantPlanView> {
    return this.planLimits.getPlanView(tenant.id, tenant.schemaName);
  }
}
