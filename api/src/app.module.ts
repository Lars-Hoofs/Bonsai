import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import { DbModule } from './db/db.module';
import { TenancyModule } from './tenancy/tenancy.module';
import { AuthModule } from './auth/auth.module';
import { AuditModule } from './audit/audit.module';
import { TenantsModule } from './tenants/tenants.module';

@Module({
  imports: [DbModule, TenancyModule, AuthModule, AuditModule, TenantsModule],
  controllers: [HealthController],
})
export class AppModule {}
