import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';
import { Pool } from 'pg';
import { AppModule } from './app.module';
import { APP_CONFIG, type AppConfig } from './config/config';
import { PG_POOL } from './db/db.module';
import { runControlPlaneMigrations } from './db/run-control-plane-migrations';
import { HttpExceptionFilter } from './common/http-exception.filter';
import { requestIdMiddleware } from './common/request-id.middleware';
import { buildOpenApiDocument } from './docs/openapi';
import { stoplightHtml } from './docs/stoplight';

// Applies to both JSON and urlencoded bodies (e.g. crawler config, website
// theme JSON, CSV/manual knowledge source `body`/`csv` fields posted as
// regular JSON). Generous enough for legitimate payloads, bounded so a
// single POST can't exhaust memory.
const MAX_JSON_BODY_SIZE = '2mb';

async function bootstrap(): Promise<void> {
  // Default body parser disabled so we can register json/urlencoded parsers
  // ourselves with an explicit size limit (see useBodyParser calls below).
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  const expressApp = app as unknown as NestExpressApplication;
  expressApp.useBodyParser('json', { limit: MAX_JSON_BODY_SIZE });
  expressApp.useBodyParser('urlencoded', {
    limit: MAX_JSON_BODY_SIZE,
    extended: true,
  });
  app.use(requestIdMiddleware);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  app.setGlobalPrefix('v1', {
    exclude: ['health', 'docs', 'docs-json', 'reference'],
  });
  app.enableShutdownHooks();

  // Run control-plane migrations before accepting traffic. The migrator
  // takes a per-track advisory lock, so this is safe when multiple
  // replicas boot concurrently — only one applies each migration file.
  const pool = app.get<Pool>(PG_POOL);
  await runControlPlaneMigrations(pool);

  const config = app.get<AppConfig>(APP_CONFIG);

  // OpenAPI spec at /docs-json, classic Swagger UI at /docs, and the
  // Stoplight-Elements themed reference at /reference — all serving one spec.
  const document = buildOpenApiDocument(app);
  SwaggerModule.setup('docs', app, document, { jsonDocumentUrl: 'docs-json' });
  app
    .getHttpAdapter()
    .get('/reference', (_req: Request, res: Response) =>
      res.type('html').send(stoplightHtml('/docs-json')),
    );

  await app.listen(config.port);
}
bootstrap().catch((error: Error) => {
  console.error('Bootstrap error:', error);
  process.exit(1);
});
