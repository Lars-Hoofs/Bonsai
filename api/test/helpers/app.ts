import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { AppModule } from '../../src/app.module';
import { APP_CONFIG, AppConfig } from '../../src/config/config';
import { PG_POOL } from '../../src/db/db.module';
import { JWT_KEY_GETTER } from '../../src/auth/oidc.verifier';
import {
  OCR_PROVIDER,
  OcrProvider,
} from '../../src/knowledge/ingestion/ocr-provider';
import { runControlPlaneMigrations } from '../../src/db/run-control-plane-migrations';
import { makeTestIdp, TEST_AUDIENCE, TEST_ISSUER, TestIdp } from './oidc';
import { HttpExceptionFilter } from '../../src/common/http-exception.filter';
import { requestIdMiddleware } from '../../src/common/request-id.middleware';

/** A DI provider override: swap the value bound to `token` for `value` (e.g.
 * to stub the Whisper TRANSCRIPTION_PROVIDER with an in-process fake). */
export interface ProviderOverride {
  token: unknown;
  value: unknown;
}

export async function buildTestApp(
  pool: Pool,
  cfgOverrides: Partial<AppConfig> = {},
  // Optional OCR provider stub: tests that exercise the OCR fallback path
  // (#24) pass a stub here rather than letting the real Tesseract-backed
  // provider run in tests. Undefined leaves the module's real provider wired
  // (harmless — OCR only ever runs when a test also sets ocrEnabled: true
  // AND uploads an image/PDF with negligible text).
  ocrProviderOverride?: OcrProvider,
  providerOverrides: ProviderOverride[] = [],
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
    // Generous default so a single spec file that (post feature-merge) drives
    // many `start` calls against one shared widget key across several describe
    // blocks doesn't trip the per-project+IP cap. The dedicated rate-limit
    // specs build their own app with a low override to assert the 429 path.
    conversationStartRatePerMin: 100,
    transcriptEmailRatePerMin: 5,
    recrawlIntervalMs: 86_400_000,
    ingestionStaleMs: 900_000,
    ingestionTimeoutMs: 60_000,
    s3Region: 'us-east-1',
    selfCheckEnabled: true,
    verificationMode: 'self-check',
    multiQueryEnabled: true,
    multiTurnContextEnabled: true,
    multiTurnMaxTurns: 6,
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
    answerTemplatesEnabled: true,
    profanityFilterEnabled: true,
    // Auto-close reaper left off in e2e so no background interval runs during
    // tests; the post-chat survey surface is on so its widget route is
    // exercised. (#40)
    autoCloseEnabled: false,
    autoCloseSweepIntervalMs: 300_000,
    autoCloseDefaultIdleMinutes: 60,
    postChatSurveyEnabled: true,
    costPer1kTokens: 0,
    estTokensPerAnswer: 1500,
    // Whisper transcription off by default in tests (audio/video uploads
    // rejected). A test that needs it overrides TRANSCRIPTION_PROVIDER.
    whisperEnabled: false,
    whisperModel: 'whisper-1',
    whisperTimeoutMs: 300_000,
    retentionPurgeIntervalMs: 21_600_000,
    // SMTP left unset: MailService stays a no-op so tests never send real mail.
    smtpPort: 587,
    smtpSecure: false,
    widgetPreviewTokenSecret: 'test-widget-preview-secret',
    // OCR (#24) defaults: enabled, matching production, but real Tesseract
    // never actually runs in tests unless a test both uploads an
    // image/PDF with negligible text AND passes ocrProviderOverride above —
    // see extractUploadText's shouldRunOcr gate.
    ocrEnabled: true,
    ocrLanguages: 'nld+eng',
    ocrMaxPages: 20,
    // Plan/tier limits (#50): the shared harness runs every plan UNLIMITED so
    // pre-existing suites (which create many projects/members on the default
    // 'starter' tenant) are unaffected by enforcement. The dedicated
    // plan-limits e2e suite fully overrides `planLimits` via cfgOverrides (and
    // sets a specific tenant's `plan` column) to exercise real enforcement.
    planLimits: {
      starter: {
        maxProjects: null,
        maxSourcesPerProject: null,
        maxMembers: null,
      },
      pro: { maxProjects: null, maxSourcesPerProject: null, maxMembers: null },
      enterprise: {
        maxProjects: null,
        maxSourcesPerProject: null,
        maxMembers: null,
      },
    },
    // Scheduler off by default in tests so no background interval fires during
    // e2e specs; specs that exercise the runner drive it explicitly.
    reportsSchedulerEnabled: false,
    reportsIntervalMs: 3_600_000,
    ...cfgOverrides,
  };
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(cfg)
    .overrideProvider(PG_POOL)
    .useValue(pool)
    .overrideProvider(JWT_KEY_GETTER)
    .useValue(idp.keyGetter);
  if (ocrProviderOverride) {
    builder = builder
      .overrideProvider(OCR_PROVIDER)
      .useValue(ocrProviderOverride);
  }
  for (const o of providerOverrides) {
    builder = builder.overrideProvider(o.token).useValue(o.value);
  }
  const mod = await builder.compile();
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
