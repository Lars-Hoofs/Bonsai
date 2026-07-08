import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { APP_CONFIG, type AppConfig } from './config/config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.setGlobalPrefix('v1', { exclude: ['health'] });
  const config = app.get<AppConfig>(APP_CONFIG);
  await app.listen(config.port);
}
bootstrap().catch((error: Error) => {
  console.error('Bootstrap error:', error);
  process.exit(1);
});
