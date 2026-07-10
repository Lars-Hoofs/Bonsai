import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPg } from './helpers/pg';
import { runControlPlaneMigrations } from '../src/db/run-control-plane-migrations';
import {
  UsageService,
  currentPeriod,
  trailingPeriods,
} from '../src/usage/usage.service';
import type { AppConfig } from '../src/config/config';

interface TenantIdRow {
  id: string;
}

describe('UsageService.summary (cost/usage analytics, #43)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  beforeAll(async () => {
    ({ container, pool } = await startPg());
    await runControlPlaneMigrations(pool);
  }, 120000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  async function makeTenant(): Promise<string> {
    const r = await pool.query<TenantIdRow>(
      `INSERT INTO tenants (name, slug, schema_name, monthly_answer_quota)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [
        `Tenant ${Math.random()}`,
        `tenant-${Math.random().toString(36).slice(2)}`,
        `t_${Math.random().toString(36).slice(2)}`,
        1000,
      ],
    );
    return r.rows[0].id;
  }

  it('trailingPeriods returns the N most recent YYYY-MM periods, most-recent-last', () => {
    const now = new Date(Date.UTC(2026, 0, 15)); // 2026-01-15
    expect(trailingPeriods(now, 3)).toEqual(['2025-11', '2025-12', '2026-01']);
    expect(trailingPeriods(now, 1)).toEqual(['2026-01']);
  });

  it('computes estimatedCost = answers * estTokensPerAnswer / 1000 * costPer1kTokens with a configured price', async () => {
    const cfg = {
      costPer1kTokens: 0.03,
      estTokensPerAnswer: 2000,
    } as AppConfig;
    const usage = new UsageService(pool, cfg);
    const tenantId = await makeTenant();

    await pool.query(
      `INSERT INTO usage_records (tenant_id, period, metric, value)
       VALUES ($1, $2, 'answers', $3)`,
      [tenantId, currentPeriod(new Date()), 7],
    );

    const summary = await usage.summary(tenantId, 3);
    const current = summary.months[summary.months.length - 1];
    expect(current.answers).toBe(7);
    expect(current.estimatedTokens).toBe(7 * 2000);
    expect(current.estimatedCost).toBeCloseTo((7 * 2000 * 0.03) / 1000, 6);
    expect(summary.totalAnswers).toBe(7);
    expect(summary.totalEstimatedCost).toBeCloseTo((7 * 2000 * 0.03) / 1000, 6);
    expect(summary.costPer1kTokens).toBe(0.03);
    expect(summary.estTokensPerAnswer).toBe(2000);
    // Months without recorded usage are zero-filled, not omitted.
    expect(summary.months).toHaveLength(3);
    expect(summary.months[0].answers).toBe(0);
    expect(summary.months[0].estimatedCost).toBe(0);
  });

  it('estimatedCost is always 0 when costPer1kTokens is 0 (default, no external pricing dependency)', async () => {
    const cfg = { costPer1kTokens: 0, estTokensPerAnswer: 1500 } as AppConfig;
    const usage = new UsageService(pool, cfg);
    const tenantId = await makeTenant();

    await pool.query(
      `INSERT INTO usage_records (tenant_id, period, metric, value)
       VALUES ($1, $2, 'answers', $3)`,
      [tenantId, currentPeriod(new Date()), 42],
    );

    const summary = await usage.summary(tenantId, 1);
    expect(summary.months[0].answers).toBe(42);
    expect(summary.months[0].estimatedTokens).toBe(42 * 1500);
    expect(summary.months[0].estimatedCost).toBe(0);
    expect(summary.totalEstimatedCost).toBe(0);
  });

  it('defaults to a 6-month window when no count is passed', async () => {
    const cfg = { costPer1kTokens: 0, estTokensPerAnswer: 1500 } as AppConfig;
    const usage = new UsageService(pool, cfg);
    const tenantId = await makeTenant();

    const summary = await usage.summary(tenantId);
    expect(summary.months).toHaveLength(6);
  });
});
