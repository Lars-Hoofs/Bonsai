import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import { DbModule } from './db/db.module';

@Module({
  imports: [DbModule],
  controllers: [HealthController],
})
export class AppModule {}
