import { readAutoCloseSettings } from './auto-close';

describe('readAutoCloseSettings', () => {
  const DEFAULT = 60;

  it('is disabled when autoCloseEnabled is missing', () => {
    expect(readAutoCloseSettings({}, DEFAULT)).toEqual({
      enabled: false,
      idleMinutes: DEFAULT,
    });
  });

  it('requires an explicit boolean true to enable (truthy strings do not count)', () => {
    expect(
      readAutoCloseSettings({ autoCloseEnabled: 'true' }, DEFAULT).enabled,
    ).toBe(false);
    expect(
      readAutoCloseSettings({ autoCloseEnabled: 1 }, DEFAULT).enabled,
    ).toBe(false);
    expect(
      readAutoCloseSettings({ autoCloseEnabled: true }, DEFAULT).enabled,
    ).toBe(true);
    expect(
      readAutoCloseSettings({ autoCloseEnabled: false }, DEFAULT).enabled,
    ).toBe(false);
  });

  it('uses a valid positive-integer idle threshold when provided', () => {
    expect(
      readAutoCloseSettings(
        { autoCloseEnabled: true, autoCloseIdleMinutes: 30 },
        DEFAULT,
      ),
    ).toEqual({ enabled: true, idleMinutes: 30 });
  });

  it('falls back to the default idle threshold for missing/garbage/zero/negative/fractional values', () => {
    for (const raw of [undefined, null, 0, -5, 1.5, 'x', {}]) {
      expect(
        readAutoCloseSettings(
          { autoCloseEnabled: true, autoCloseIdleMinutes: raw },
          DEFAULT,
        ).idleMinutes,
      ).toBe(DEFAULT);
    }
  });
});
