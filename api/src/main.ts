import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { APP_CONFIG, type AppConfig } from './config/config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const config = app.get<AppConfig>(APP_CONFIG);
  await app.listen(config.port);
}
bootstrap().catch((error: Error) => {
  console.error('Bootstrap error:', error);
  process.exit(1);
});
