import { BadRequestException } from '@nestjs/common';
import { assertSettingsPatchShape } from './settings-validation';

describe('assertSettingsPatchShape', () => {
  it('accepts an empty object', () => {
    expect(() => assertSettingsPatchShape({})).not.toThrow();
  });

  it.each([null, undefined, 'a string', 42, true, ['a']])(
    'rejects non-plain-object input: %p',
    (value) => {
      expect(() => assertSettingsPatchShape(value)).toThrow(
        BadRequestException,
      );
    },
  );

  it('rejects unknown keys', () => {
    expect(() => assertSettingsPatchShape({ notAKey: 1 })).toThrow(
      'Unknown settings key: notAKey',
    );
  });

  describe('confidenceThreshold', () => {
    it('accepts values between 0 and 1 inclusive', () => {
      expect(() =>
        assertSettingsPatchShape({ confidenceThreshold: 0 }),
      ).not.toThrow();
      expect(() =>
        assertSettingsPatchShape({ confidenceThreshold: 1 }),
      ).not.toThrow();
      expect(() =>
        assertSettingsPatchShape({ confidenceThreshold: 0.75 }),
      ).not.toThrow();
    });

    it.each([-0.01, 1.01, 2, -1, NaN])('rejects out-of-range value %p', (v) => {
      expect(() =>
        assertSettingsPatchShape({ confidenceThreshold: v }),
      ).toThrow(BadRequestException);
    });

    it('rejects a non-number', () => {
      expect(() =>
        assertSettingsPatchShape({ confidenceThreshold: '0.5' }),
      ).toThrow(BadRequestException);
    });
  });

  describe('verificationMode', () => {
    it('accepts self-check and claim-nli', () => {
      expect(() =>
        assertSettingsPatchShape({ verificationMode: 'self-check' }),
      ).not.toThrow();
      expect(() =>
        assertSettingsPatchShape({ verificationMode: 'claim-nli' }),
      ).not.toThrow();
    });

    it('rejects an unknown mode', () => {
      expect(() =>
        assertSettingsPatchShape({ verificationMode: 'bogus' }),
      ).toThrow(BadRequestException);
    });
  });

  describe('businessHours', () => {
    it('accepts a well-formed schedule', () => {
      expect(() =>
        assertSettingsPatchShape({
          businessHours: {
            timezone: 'Europe/Amsterdam',
            intervals: [{ day: 1, open: '09:00', close: '17:00' }],
          },
        }),
      ).not.toThrow();
    });

    it('accepts an empty intervals array', () => {
      expect(() =>
        assertSettingsPatchShape({
          businessHours: { timezone: 'Europe/Amsterdam', intervals: [] },
        }),
      ).not.toThrow();
    });

    it('rejects a missing timezone', () => {
      expect(() =>
        assertSettingsPatchShape({
          businessHours: { intervals: [] },
        }),
      ).toThrow(BadRequestException);
    });

    it('rejects an unknown IANA timezone', () => {
      expect(() =>
        assertSettingsPatchShape({
          businessHours: { timezone: 'Not/AZone', intervals: [] },
        }),
      ).toThrow(/timezone/);
    });

    it('rejects a non-array intervals', () => {
      expect(() =>
        assertSettingsPatchShape({
          businessHours: { timezone: 'Europe/Amsterdam', intervals: 'nope' },
        }),
      ).toThrow(BadRequestException);
    });

    it('rejects an interval with an out-of-range day', () => {
      expect(() =>
        assertSettingsPatchShape({
          businessHours: {
            timezone: 'Europe/Amsterdam',
            intervals: [{ day: 8, open: '09:00', close: '17:00' }],
          },
        }),
      ).toThrow(/day/);
    });

    it('rejects a malformed open/close time', () => {
      expect(() =>
        assertSettingsPatchShape({
          businessHours: {
            timezone: 'Europe/Amsterdam',
            intervals: [{ day: 1, open: '9am', close: '17:00' }],
          },
        }),
      ).toThrow(/open/);
    });

    it('rejects a non-object businessHours', () => {
      expect(() => assertSettingsPatchShape({ businessHours: 'nope' })).toThrow(
        BadRequestException,
      );
    });
  });

  describe('afterHoursMessage', () => {
    it('accepts a string', () => {
      expect(() =>
        assertSettingsPatchShape({ afterHoursMessage: 'We are closed' }),
      ).not.toThrow();
    });

    it('rejects a non-string', () => {
      expect(() =>
        assertSettingsPatchShape({ afterHoursMessage: 123 }),
      ).toThrow(BadRequestException);
    });
  });

  describe('retrievalWindow', () => {
    it('accepts a non-negative integer', () => {
      expect(() =>
        assertSettingsPatchShape({ retrievalWindow: 0 }),
      ).not.toThrow();
      expect(() =>
        assertSettingsPatchShape({ retrievalWindow: 5 }),
      ).not.toThrow();
    });

    it('rejects a negative integer', () => {
      expect(() => assertSettingsPatchShape({ retrievalWindow: -1 })).toThrow(
        BadRequestException,
      );
    });

    it('rejects a non-integer', () => {
      expect(() => assertSettingsPatchShape({ retrievalWindow: 1.5 })).toThrow(
        BadRequestException,
      );
    });
  });

  describe('boolean feature toggles', () => {
    it.each([
      'selfCheckEnabled',
      'multiQueryEnabled',
      'toolCallingEnabled',
      'followupSuggestionsEnabled',
      'dedupEnabled',
    ])('accepts a boolean for %s', (key) => {
      expect(() => assertSettingsPatchShape({ [key]: true })).not.toThrow();
      expect(() => assertSettingsPatchShape({ [key]: false })).not.toThrow();
    });

    it.each([
      'selfCheckEnabled',
      'multiQueryEnabled',
      'toolCallingEnabled',
      'followupSuggestionsEnabled',
      'dedupEnabled',
    ])('rejects a non-boolean for %s', (key) => {
      expect(() => assertSettingsPatchShape({ [key]: 'yes' })).toThrow(
        BadRequestException,
      );
    });
  });

  it('accepts a combined valid patch', () => {
    expect(() =>
      assertSettingsPatchShape({
        confidenceThreshold: 0.6,
        businessHours: {
          timezone: 'Europe/Amsterdam',
          intervals: [{ day: 1, open: '09:00', close: '17:00' }],
        },
        afterHoursMessage: 'closed',
        selfCheckEnabled: true,
        retrievalWindow: 3,
      }),
    ).not.toThrow();
  });
});
