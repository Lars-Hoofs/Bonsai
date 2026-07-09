import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { APP_CONFIG, AppConfig } from '../src/config/config';
import { PG_POOL } from '../src/db/db.module';
import { buildOpenApiDocument } from '../src/docs/openapi';

// The OpenAPI document is derived from route decorators, so it can be built
// without a database. A stub pool satisfies DI/shutdown without any query.
const stubPool = {
  end: async (): Promise<void> => {},
} as unknown as import('pg').Pool;

const cfg: AppConfig = {
  databaseUrl: 'postgres://x',
  dbStatementTimeoutMs: 30_000,
  dbIdleTxTimeoutMs: 30_000,
  port: 0,
  nodeEnv: 'test',
  oidcIssuer: 'https://id.example.eu',
  oidcAudience: 'bonsai-api',
  oidcJwksUrl: 'https://id.example.eu/keys',
  embeddingDim: 1024,
  rateLimitPerMinute: 120,
  recrawlIntervalMs: 86_400_000,
  ingestionStaleMs: 900_000,
  ingestionTimeoutMs: 60_000,
  s3Region: 'us-east-1',
  selfCheckEnabled: true,
  widgetCorsOrigins: [],
};

describe('OpenAPI document', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_CONFIG)
      .useValue(cfg)
      .overrideProvider(PG_POOL)
      .useValue(stubPool)
      .compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('v1', {
      exclude: ['health', 'docs', 'docs-json', 'reference'],
    });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('includes the core API paths under /v1', () => {
    const doc = buildOpenApiDocument(app);
    const paths = Object.keys(doc.paths);
    expect(paths).toContain('/v1/tenants');
    expect(paths.some((p) => p.endsWith('/knowledge/sources'))).toBe(true);
    expect(paths.some((p) => p.endsWith('/answer'))).toBe(true);
    expect(paths.some((p) => p === '/v1/widget/config')).toBe(true);
    expect(doc.info.title).toBe('Bonsai API');
  });
});
