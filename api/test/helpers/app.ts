import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { AppModule } from '../../src/app.module';
import { APP_CONFIG, AppConfig } from '../../src/config/config';
import { PG_POOL } from '../../src/db/db.module';
import { JWT_KEY_GETTER } from '../../src/auth/oidc.verifier';
import { runControlPlaneMigrations } from '../../src/db/run-control-plane-migrations';
import { makeTestIdp, TEST_AUDIENCE, TEST_ISSUER, TestIdp } from './oidc';
import { HttpExceptionFilter } from '../../src/common/http-exception.filter';
import { requestIdMiddleware } from '../../src/common/request-id.middleware';

export async function buildTestApp(
  pool: Pool,
  cfgOverrides: Partial<AppConfig> = {},
): Promise<{ app: INestApplication; idp: TestIdp }> {
  await runControlPlaneMigrations(pool);
  const idp = await makeTestIdp();
  const cfg: AppConfig = {
    databaseUrl: 'overridden',
    dbStatementTimeoutMs: 30_000,
    dbIdleTxTimeoutMs: 30_000,
    port: 0,
    nodeEnv: 'test',
    oidcIssuer: TEST_ISSUER,
    oidcAudience: TEST_AUDIENCE,
    oidcJwksUrl: 'https://unused.example/keys',
    embeddingDim: 1024,
    rateLimitPerMinute: 120,
    widgetConfigRatePerMin: 60,
    conversationStartRatePerMin: 20,
    recrawlIntervalMs: 86_400_000,
    ingestionStaleMs: 900_000,
    ingestionTimeoutMs: 60_000,
    s3Region: 'us-east-1',
    selfCheckEnabled: true,
    multiQueryEnabled: true,
    retrievalWindow: 1,
    billingEnabled: true,
    widgetCorsOrigins: [],
    ...cfgOverrides,
  };
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(cfg)
    .overrideProvider(PG_POOL)
    .useValue(pool)
    .overrideProvider(JWT_KEY_GETTER)
    .useValue(idp.keyGetter)
    .compile();
  const app = mod.createNestApplication();
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
    exclude: ['health', 'docs', 'docs-json', 'reference', 'metrics'],
  });
  await app.init();
  return { app, idp };
}
