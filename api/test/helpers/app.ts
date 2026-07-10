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
    verificationMode: 'self-check',
    multiQueryEnabled: true,
    retrievalWindow: 1,
    billingEnabled: true,
    widgetCorsOrigins: [],
    // A valid 32-byte key so the EncryptionService encrypt/decrypt path is
    // actually exercised in e2e tests (connectors credentials, etc.),
    // rather than every test hitting the "ENCRYPTION_KEY not configured"
    // error path.
    encryptionKey: Buffer.alloc(32, 42),
    dedupEnabled: true,
    nearDupThreshold: 0.97,
    frustrationAutoEscalateEnabled: true,
    frustrationRefusalStreak: 2,
    costPer1kTokens: 0,
    estTokensPerAnswer: 1500,
    // SMTP left unset: MailService stays a no-op so tests never send real mail.
    smtpPort: 587,
    smtpSecure: false,
    // Scheduler off by default in tests so no background interval fires during
    // e2e specs; specs that exercise the runner drive it explicitly.
    reportsSchedulerEnabled: false,
    reportsIntervalMs: 3_600_000,
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
