import { BadRequestException } from '@nestjs/common';
import {
  DEFAULT_TARGETING,
  DEFAULT_TRIGGERS,
  sanitizeTargeting,
  sanitizeTriggers,
} from './behavior-validation';

describe('sanitizeTargeting (#11 page-targeting rules)', () => {
  it('returns the default when given null/undefined', () => {
    expect(sanitizeTargeting(undefined)).toEqual(DEFAULT_TARGETING);
    expect(sanitizeTargeting(null)).toEqual(DEFAULT_TARGETING);
  });

  it('accepts and normalizes a valid glob + regex rule set', () => {
    const out = sanitizeTargeting({
      defaultShow: false,
      rules: [
        { mode: 'show', matchType: 'glob', pattern: '/help/*' },
        { mode: 'hide', matchType: 'regex', pattern: '^/admin/.*$' },
      ],
    });
    expect(out).toEqual({
      defaultShow: false,
      rules: [
        { mode: 'show', matchType: 'glob', pattern: '/help/*' },
        { mode: 'hide', matchType: 'regex', pattern: '^/admin/.*$' },
      ],
    });
  });

  it('defaults defaultShow to true and drops unknown keys', () => {
    const out = sanitizeTargeting({
      rules: [{ mode: 'hide', matchType: 'glob', pattern: '/x', evil: 1 }],
      extra: 'nope',
    });
    expect(out.defaultShow).toBe(true);
    expect(out.rules[0]).toEqual({
      mode: 'hide',
      matchType: 'glob',
      pattern: '/x',
    });
    expect((out as Record<string, unknown>).extra).toBeUndefined();
  });

  it('rejects a non-object', () => {
    expect(() => sanitizeTargeting('nope')).toThrow(BadRequestException);
  });

  it('rejects rules that are not an array', () => {
    expect(() => sanitizeTargeting({ rules: {} })).toThrow(
      'rules must be an array',
    );
  });

  it('rejects more than 50 rules', () => {
    const rules = Array.from({ length: 51 }, () => ({
      mode: 'show',
      matchType: 'glob',
      pattern: '/a',
    }));
    expect(() => sanitizeTargeting({ rules })).toThrow('Too many targeting');
  });

  it('rejects an invalid mode', () => {
    expect(() =>
      sanitizeTargeting({
        rules: [{ mode: 'toggle', matchType: 'glob', pattern: '/a' }],
      }),
    ).toThrow('mode must be');
  });

  it('rejects an invalid matchType', () => {
    expect(() =>
      sanitizeTargeting({
        rules: [{ mode: 'show', matchType: 'wildcard', pattern: '/a' }],
      }),
    ).toThrow('matchType must be');
  });

  it('rejects an empty pattern', () => {
    expect(() =>
      sanitizeTargeting({
        rules: [{ mode: 'show', matchType: 'glob', pattern: '' }],
      }),
    ).toThrow('pattern must be a non-empty string');
  });

  it('rejects an invalid regex pattern', () => {
    expect(() =>
      sanitizeTargeting({
        rules: [{ mode: 'hide', matchType: 'regex', pattern: '([a-z' }],
      }),
    ).toThrow('not a valid regular expression');
  });

  it('does not validate glob patterns as regex', () => {
    expect(() =>
      sanitizeTargeting({
        rules: [{ mode: 'show', matchType: 'glob', pattern: '([unclosed' }],
      }),
    ).not.toThrow();
  });
});

describe('sanitizeTriggers (#12 proactive triggers)', () => {
  it('returns the default when given null/undefined', () => {
    expect(sanitizeTriggers(undefined)).toEqual(DEFAULT_TRIGGERS);
    expect(sanitizeTriggers(null)).toEqual(DEFAULT_TRIGGERS);
  });

  it('accepts a full valid trigger config and drops unknown keys', () => {
    const out = sanitizeTriggers({
      afterSeconds: 10,
      scrollDepth: 50,
      exitIntent: true,
      sneaky: 'x',
    });
    expect(out).toEqual({
      afterSeconds: 10,
      scrollDepth: 50,
      exitIntent: true,
    });
  });

  it('coerces missing fields to null/false', () => {
    expect(sanitizeTriggers({})).toEqual({
      afterSeconds: null,
      scrollDepth: null,
      exitIntent: false,
    });
  });

  it('rejects a non-object', () => {
    expect(() => sanitizeTriggers(5)).toThrow(BadRequestException);
  });

  it('rejects a non-numeric afterSeconds', () => {
    expect(() => sanitizeTriggers({ afterSeconds: 'soon' })).toThrow(
      'afterSeconds must be a number',
    );
  });

  it('rejects afterSeconds beyond 24h', () => {
    expect(() => sanitizeTriggers({ afterSeconds: 86401 })).toThrow(
      'afterSeconds must be between',
    );
  });

  it('rejects a negative afterSeconds', () => {
    expect(() => sanitizeTriggers({ afterSeconds: -1 })).toThrow(
      'afterSeconds must be between',
    );
  });

  it('rejects scrollDepth outside 0-100', () => {
    expect(() => sanitizeTriggers({ scrollDepth: 101 })).toThrow(
      'scrollDepth must be between',
    );
  });
});
