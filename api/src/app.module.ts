import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import { DbModule } from './db/db.module';
import { TenancyModule } from './tenancy/tenancy.module';
import { AuthModule } from './auth/auth.module';

@Module({
  imports: [DbModule, TenancyModule, AuthModule],
  controllers: [HealthController],
})
export class AppModule {}
