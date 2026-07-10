import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { SetSourceScheduleDto } from './dto';

function errorsFor(payload: unknown): string[] {
  const dto = plainToInstance(SetSourceScheduleDto, payload);
  return validateSync(dto).flatMap((e) => Object.keys(e.constraints ?? {}));
}

describe('SetSourceScheduleDto', () => {
  it('accepts a valid interval at or above the 60s floor', () => {
    expect(errorsFor({ recrawlIntervalMs: 60_000 })).toEqual([]);
    expect(errorsFor({ recrawlIntervalMs: 3_600_000 })).toEqual([]);
  });

  it('accepts null to clear the schedule', () => {
    expect(errorsFor({ recrawlIntervalMs: null })).toEqual([]);
  });

  it('accepts an omitted field (optional)', () => {
    expect(errorsFor({})).toEqual([]);
  });

  it('rejects an interval below the 60s floor', () => {
    expect(errorsFor({ recrawlIntervalMs: 1_000 })).toContain('min');
  });

  it('rejects a non-integer interval', () => {
    expect(errorsFor({ recrawlIntervalMs: 1.5 })).toContain('isInt');
  });
});
