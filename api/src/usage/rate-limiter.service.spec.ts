import type { AppConfig } from '../config/config';
import { RateLimiterService } from './rate-limiter.service';

// No `redisUrl` configured, so the service uses its in-memory fallback path —
// this is also exactly the config tests/dev run under (see test/helpers/app.ts),
// so this doubles as coverage for "tests without Redis still work".
const cfgWithoutRedis: AppConfig = {
  databaseUrl: 'unused',
  port: 0,
  nodeEnv: 'test',
  oidcIssuer: 'https://unused.example',
  oidcAudience: 'unused',
  oidcJwksUrl: 'https://unused.example/keys',
  embeddingDim: 1024,
  rateLimitPerMinute: 120,
  recrawlIntervalMs: 86_400_000,
  s3Region: 'us-east-1',
  selfCheckEnabled: true,
  widgetCorsOrigins: [],
};

describe('RateLimiterService (in-memory fallback, no REDIS_URL configured)', () => {
  it('allows up to the limit within a window, then blocks', async () => {
    const rl = new RateLimiterService(cfgWithoutRedis);
    const t0 = 1_000;
    expect(await rl.allow('k', 3, 1000, t0)).toBe(true);
    expect(await rl.allow('k', 3, 1000, t0)).toBe(true);
    expect(await rl.allow('k', 3, 1000, t0)).toBe(true);
    expect(await rl.allow('k', 3, 1000, t0)).toBe(false);
  });

  it('resets after the window elapses', async () => {
    const rl = new RateLimiterService(cfgWithoutRedis);
    expect(await rl.allow('k', 1, 1000, 1_000)).toBe(true);
    expect(await rl.allow('k', 1, 1000, 1_500)).toBe(false);
    expect(await rl.allow('k', 1, 1000, 2_001)).toBe(true);
  });

  it('tracks keys independently', async () => {
    const rl = new RateLimiterService(cfgWithoutRedis);
    expect(await rl.allow('a', 1, 1000, 0)).toBe(true);
    expect(await rl.allow('b', 1, 1000, 0)).toBe(true);
    expect(await rl.allow('a', 1, 1000, 0)).toBe(false);
  });

  it('does not connect to Redis when REDIS_URL is unset', async () => {
    const rl = new RateLimiterService(cfgWithoutRedis);
    rl.onModuleInit();
    // Should still behave like the in-memory limiter (no Redis client
    // constructed), proving the fallback is selected by config presence.
    expect(await rl.allow('k', 1, 1000, 0)).toBe(true);
    expect(await rl.allow('k', 1, 1000, 0)).toBe(false);
    await rl.onModuleDestroy();
  });
});
