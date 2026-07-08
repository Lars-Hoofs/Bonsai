import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Pool } from 'pg';
import { AppModule } from './app.module';
import { APP_CONFIG, type AppConfig } from './config/config';
import { PG_POOL } from './db/db.module';
import { runControlPlaneMigrations } from './db/run-control-plane-migrations';
import { HttpExceptionFilter } from './common/http-exception.filter';
import { requestIdMiddleware } from './common/request-id.middleware';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.use(requestIdMiddleware);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  app.setGlobalPrefix('v1', { exclude: ['health', 'docs'] });
  app.enableShutdownHooks();

  // Run control-plane migrations before accepting traffic. The migrator
  // takes a per-track advisory lock, so this is safe when multiple
  // replicas boot concurrently — only one applies each migration file.
  const pool = app.get<Pool>(PG_POOL);
  await runControlPlaneMigrations(pool);

  const config = app.get<AppConfig>(APP_CONFIG);

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Bonsai API')
      .setVersion('0.1')
      .addBearerAuth()
      .build(),
  );
  SwaggerModule.setup('docs', app, document);

  await app.listen(config.port);
}
bootstrap().catch((error: Error) => {
  console.error('Bootstrap error:', error);
  process.exit(1);
});
