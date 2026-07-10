import { Global, Module } from '@nestjs/common';
import { TenancyModule } from '../tenancy/tenancy.module';
import { PlanLimitsController } from './plan-limits.controller';
import { PlanLimitsService } from './plan-limits.service';

/**
 * Self-managed plan/tier limits (#50). Global so any create-path service
 * (projects, knowledge sources, tenants/members, ...) can inject
 * PlanLimitsService without every consuming module having to import this
 * one explicitly. Registered last in AppModule per convention for
 * additive, low-risk feature modules.
 */
@Global()
@Module({
  imports: [TenancyModule],
  controllers: [PlanLimitsController],
  providers: [PlanLimitsService],
  exports: [PlanLimitsService],
})
export class PlanLimitsModule {}
