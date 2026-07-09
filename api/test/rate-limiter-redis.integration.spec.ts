import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import type { AppConfig } from '../src/config/config';
import { RateLimiterService } from '../src/usage/rate-limiter.service';

/**
 * Verifies the Redis-backed path of RateLimiterService (used whenever
 * REDIS_URL is configured, e.g. in production with multiple replicas): a
 * fixed window enforced via INCR + PEXPIRE, shared across independent
 * RateLimiterService instances the same way it would be shared across
 * separate app replicas.
 */
describe('RateLimiterService (Redis-backed)', () => {
  let redis: StartedRedisContainer;
  let cfg: AppConfig;

  beforeAll(async () => {
    redis = await new RedisContainer('redis:7-alpine').start();
    cfg = {
      databaseUrl: 'unused',
      dbStatementTimeoutMs: 30_000,
      dbIdleTxTimeoutMs: 30_000,
      port: 0,
      nodeEnv: 'test',
      oidcIssuer: 'https://unused.example',
      oidcAudience: 'unused',
      oidcJwksUrl: 'https://unused.example/keys',
      embeddingDim: 1024,
      rateLimitPerMinute: 120,
      redisUrl: redis.getConnectionUrl(),
      recrawlIntervalMs: 86_400_000,
      ingestionStaleMs: 900_000,
      ingestionTimeoutMs: 60_000,
      s3Region: 'us-east-1',
      selfCheckEnabled: true,
      widgetCorsOrigins: [],
    };
  }, 120_000);

  afterAll(async () => {
    await redis.stop();
  });

  it('allows up to the limit within a window, then blocks the N+1th call', async () => {
    const rl = new RateLimiterService(cfg);
    rl.onModuleInit();
    try {
      const key = `test:${Date.now()}:a`;
      expect(await rl.allow(key, 3, 60_000, Date.now())).toBe(true);
      expect(await rl.allow(key, 3, 60_000, Date.now())).toBe(true);
      expect(await rl.allow(key, 3, 60_000, Date.now())).toBe(true);
      expect(await rl.allow(key, 3, 60_000, Date.now())).toBe(false);
    } finally {
      await rl.onModuleDestroy();
    }
  });

  it('resets the count once the window (PEXPIRE) elapses', async () => {
    const rl = new RateLimiterService(cfg);
    rl.onModuleInit();
    try {
      const key = `test:${Date.now()}:b`;
      expect(await rl.allow(key, 1, 500, Date.now())).toBe(true);
      expect(await rl.allow(key, 1, 500, Date.now())).toBe(false);
      await new Promise((r) => setTimeout(r, 700));
      expect(await rl.allow(key, 1, 500, Date.now())).toBe(true);
    } finally {
      await rl.onModuleDestroy();
    }
  });

  it('shares the counter across separate RateLimiterService instances (simulating separate replicas)', async () => {
    const rlA = new RateLimiterService(cfg);
    const rlB = new RateLimiterService(cfg);
    rlA.onModuleInit();
    rlB.onModuleInit();
    try {
      const key = `test:${Date.now()}:c`;
      expect(await rlA.allow(key, 2, 60_000, Date.now())).toBe(true);
      expect(await rlB.allow(key, 2, 60_000, Date.now())).toBe(true);
      // Third call, regardless of which "replica" makes it, is over the
      // shared limit of 2 — proving the counter isn't node-local.
      expect(await rlA.allow(key, 2, 60_000, Date.now())).toBe(false);
      expect(await rlB.allow(key, 2, 60_000, Date.now())).toBe(false);
    } finally {
      await rlA.onModuleDestroy();
      await rlB.onModuleDestroy();
    }
  });

  it('tracks keys independently', async () => {
    const rl = new RateLimiterService(cfg);
    rl.onModuleInit();
    try {
      const keyA = `test:${Date.now()}:d1`;
      const keyB = `test:${Date.now()}:d2`;
      expect(await rl.allow(keyA, 1, 60_000, Date.now())).toBe(true);
      expect(await rl.allow(keyB, 1, 60_000, Date.now())).toBe(true);
      expect(await rl.allow(keyA, 1, 60_000, Date.now())).toBe(false);
    } finally {
      await rl.onModuleDestroy();
    }
  });
});
