import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import { APP_CONFIG, loadConfig } from './config/config';

@Module({
  controllers: [HealthController],
  providers: [
    { provide: APP_CONFIG, useFactory: () => loadConfig(process.env) },
  ],
  exports: [APP_CONFIG],
})
export class AppModule {}
