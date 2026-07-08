import { RateLimiterService } from './rate-limiter.service';

describe('RateLimiterService', () => {
  it('allows up to the limit within a window, then blocks', () => {
    const rl = new RateLimiterService();
    const t0 = 1_000;
    expect(rl.allow('k', 3, 1000, t0)).toBe(true);
    expect(rl.allow('k', 3, 1000, t0)).toBe(true);
    expect(rl.allow('k', 3, 1000, t0)).toBe(true);
    expect(rl.allow('k', 3, 1000, t0)).toBe(false);
  });

  it('resets after the window elapses', () => {
    const rl = new RateLimiterService();
    expect(rl.allow('k', 1, 1000, 1_000)).toBe(true);
    expect(rl.allow('k', 1, 1000, 1_500)).toBe(false);
    expect(rl.allow('k', 1, 1000, 2_001)).toBe(true);
  });

  it('tracks keys independently', () => {
    const rl = new RateLimiterService();
    expect(rl.allow('a', 1, 1000, 0)).toBe(true);
    expect(rl.allow('b', 1, 1000, 0)).toBe(true);
    expect(rl.allow('a', 1, 1000, 0)).toBe(false);
  });
});
