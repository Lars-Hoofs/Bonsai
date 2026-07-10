import {
  computeDeadlines,
  deriveSlaState,
  isBreached,
  isValidTransition,
  readSlaPolicy,
  WORKFLOW_STATUSES,
} from './sla';

describe('readSlaPolicy', () => {
  it('reads positive finite durations', () => {
    expect(
      readSlaPolicy({
        sla: { firstResponseMinutes: 15, resolutionMinutes: 120 },
      }),
    ).toEqual({ firstResponseMinutes: 15, resolutionMinutes: 120 });
  });

  it('ignores missing / malformed / non-positive values', () => {
    expect(readSlaPolicy({})).toEqual({});
    expect(readSlaPolicy({ sla: null })).toEqual({});
    expect(readSlaPolicy({ sla: 'nope' })).toEqual({});
    expect(
      readSlaPolicy({
        sla: {
          firstResponseMinutes: 0,
          resolutionMinutes: -5,
        },
      }),
    ).toEqual({});
    expect(
      readSlaPolicy({
        sla: { firstResponseMinutes: 'x', resolutionMinutes: Infinity },
      }),
    ).toEqual({});
  });

  it('accepts one milestone without the other', () => {
    expect(readSlaPolicy({ sla: { firstResponseMinutes: 30 } })).toEqual({
      firstResponseMinutes: 30,
    });
  });
});

describe('computeDeadlines', () => {
  const start = new Date('2026-07-10T10:00:00.000Z');

  it('adds minutes to the start time', () => {
    expect(
      computeDeadlines(
        { firstResponseMinutes: 15, resolutionMinutes: 120 },
        start,
      ),
    ).toEqual({
      firstResponseDueAt: new Date('2026-07-10T10:15:00.000Z'),
      resolutionDueAt: new Date('2026-07-10T12:00:00.000Z'),
    });
  });

  it('yields null deadlines for an empty policy', () => {
    expect(computeDeadlines({}, start)).toEqual({
      firstResponseDueAt: null,
      resolutionDueAt: null,
    });
  });
});

describe('isBreached', () => {
  const due = new Date('2026-07-10T10:15:00.000Z');

  it('is false when there is no deadline', () => {
    expect(isBreached(null, null, new Date())).toBe(false);
  });

  it('is false when the milestone was reached before the deadline', () => {
    expect(
      isBreached(due, new Date('2026-07-10T10:10:00.000Z'), new Date()),
    ).toBe(false);
  });

  it('is true when the milestone was reached after the deadline', () => {
    expect(
      isBreached(due, new Date('2026-07-10T10:20:00.000Z'), new Date()),
    ).toBe(true);
  });

  it('is false before the deadline when the milestone is still pending', () => {
    expect(isBreached(due, null, new Date('2026-07-10T10:05:00.000Z'))).toBe(
      false,
    );
  });

  it('is true past the deadline when the milestone is still pending', () => {
    expect(isBreached(due, null, new Date('2026-07-10T10:30:00.000Z'))).toBe(
      true,
    );
  });
});

describe('deriveSlaState', () => {
  it('surfaces ISO timestamps and both breach flags', () => {
    const now = new Date('2026-07-10T11:00:00.000Z');
    const state = deriveSlaState(
      {
        firstResponseDueAt: new Date('2026-07-10T10:15:00.000Z'),
        resolutionDueAt: new Date('2026-07-10T12:00:00.000Z'),
        firstRespondedAt: new Date('2026-07-10T10:30:00.000Z'),
        resolvedAt: null,
      },
      now,
    );
    // First response landed after its deadline -> breached.
    expect(state.firstResponseBreached).toBe(true);
    // Resolution deadline still in the future, not yet resolved -> not breached.
    expect(state.resolutionBreached).toBe(false);
    expect(state.firstRespondedAt).toBe('2026-07-10T10:30:00.000Z');
    expect(state.resolvedAt).toBeNull();
  });

  it('reports no breaches when there is no policy', () => {
    const state = deriveSlaState(
      {
        firstResponseDueAt: null,
        resolutionDueAt: null,
        firstRespondedAt: null,
        resolvedAt: null,
      },
      new Date(),
    );
    expect(state.firstResponseBreached).toBe(false);
    expect(state.resolutionBreached).toBe(false);
    expect(state.firstResponseDueAt).toBeNull();
  });
});

describe('isValidTransition', () => {
  it('allows any move between distinct lifecycle values', () => {
    expect(isValidTransition('open', 'pending')).toBe(true);
    expect(isValidTransition('pending', 'resolved')).toBe(true);
    expect(isValidTransition('resolved', 'open')).toBe(true);
  });

  it('rejects a no-op transition', () => {
    for (const s of WORKFLOW_STATUSES) {
      expect(isValidTransition(s, s)).toBe(false);
    }
  });
});
