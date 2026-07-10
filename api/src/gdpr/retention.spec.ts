import {
  isConversationDue,
  MS_PER_DAY,
  retentionCutoff,
  retentionEnabled,
} from './retention';

describe('retention window logic', () => {
  const now = new Date('2026-07-10T12:00:00.000Z');

  describe('retentionEnabled', () => {
    it('is true only for a positive finite number', () => {
      expect(retentionEnabled(30)).toBe(true);
      expect(retentionEnabled(1)).toBe(true);
    });

    it('is false for unset / non-positive / non-finite', () => {
      expect(retentionEnabled(null)).toBe(false);
      expect(retentionEnabled(undefined)).toBe(false);
      expect(retentionEnabled(0)).toBe(false);
      expect(retentionEnabled(-5)).toBe(false);
      expect(retentionEnabled(Number.NaN)).toBe(false);
      expect(retentionEnabled(Number.POSITIVE_INFINITY)).toBe(false);
    });
  });

  describe('retentionCutoff', () => {
    it('is now minus retentionDays for an enabled window', () => {
      const cutoff = retentionCutoff(30, now);
      expect(cutoff).not.toBeNull();
      expect(cutoff!.getTime()).toBe(now.getTime() - 30 * MS_PER_DAY);
    });

    it('is null when retention is disabled', () => {
      expect(retentionCutoff(null, now)).toBeNull();
      expect(retentionCutoff(0, now)).toBeNull();
    });
  });

  describe('isConversationDue', () => {
    it('purges data strictly older than the window', () => {
      const old = new Date(now.getTime() - 31 * MS_PER_DAY);
      expect(isConversationDue(old, 30, now)).toBe(true);
    });

    it('retains data younger than the window', () => {
      const recent = new Date(now.getTime() - 29 * MS_PER_DAY);
      expect(isConversationDue(recent, 30, now)).toBe(false);
    });

    it('retains data exactly at the boundary (exclusive cutoff)', () => {
      const exactly = new Date(now.getTime() - 30 * MS_PER_DAY);
      expect(isConversationDue(exactly, 30, now)).toBe(false);
    });

    it('never purges when retention is disabled, however old', () => {
      const ancient = new Date(now.getTime() - 10_000 * MS_PER_DAY);
      expect(isConversationDue(ancient, null, now)).toBe(false);
      expect(isConversationDue(ancient, 0, now)).toBe(false);
    });
  });
});
