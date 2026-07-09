import { HttpException } from '@nestjs/common';
import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPg } from './helpers/pg';
import { runControlPlaneMigrations } from '../src/db/run-control-plane-migrations';
import { UsageService } from '../src/usage/usage.service';
import type { AppConfig } from '../src/config/config';

interface TenantIdRow {
  id: string;
}

const billingOn = { billingEnabled: true } as AppConfig;
const billingOff = { billingEnabled: false } as AppConfig;

describe('UsageService.reserveAnswer quota race (TOCTOU)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let usage: UsageService;

  beforeAll(async () => {
    ({ container, pool } = await startPg());
    await runControlPlaneMigrations(pool);
    usage = new UsageService(pool, billingOn);
  }, 120000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  async function makeTenant(quota: number): Promise<string> {
    const r = await pool.query<TenantIdRow>(
      `INSERT INTO tenants (name, slug, schema_name, monthly_answer_quota)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [
        `Tenant ${quota}-${Math.random()}`,
        `tenant-${Math.random().toString(36).slice(2)}`,
        `t_${Math.random().toString(36).slice(2)}`,
        quota,
      ],
    );
    return r.rows[0].id;
  }

  async function usedValue(tenantId: string): Promise<number> {
    const view = await usage.current(tenantId, 'answers');
    return view.used;
  }

  it('sequential: allows exactly up to quota, then throws 402 on the next attempt', async () => {
    const tenantId = await makeTenant(3);

    await usage.reserveAnswer(tenantId);
    await usage.reserveAnswer(tenantId);
    await usage.reserveAnswer(tenantId);

    await expect(usage.reserveAnswer(tenantId)).rejects.toThrow(HttpException);
    await expect(usage.reserveAnswer(tenantId)).rejects.toMatchObject({
      status: 402,
    });

    expect(await usedValue(tenantId)).toBe(3);
  });

  it('with billing DISABLED: meters usage but never enforces the quota (auto-paid)', async () => {
    const noBilling = new UsageService(pool, billingOff);
    const tenantId = await makeTenant(2); // quota 2, but billing is off

    // Far more reservations than the quota -- none should throw.
    for (let i = 0; i < 5; i++) {
      await expect(noBilling.reserveAnswer(tenantId)).resolves.toBeUndefined();
    }
    // Usage is still metered (counter climbs past the quota), just not gated.
    expect(await usedValue(tenantId)).toBe(5);
  });

  it('rejects a tenant with a 0 answer quota outright', async () => {
    const tenantId = await makeTenant(0);
    await expect(usage.reserveAnswer(tenantId)).rejects.toMatchObject({
      status: 402,
    });
    expect(await usedValue(tenantId)).toBe(0);
  });

  it('concurrent: exactly N of M >> N simultaneous reservations succeed, counter never exceeds N', async () => {
    const quota = 3;
    const attempts = 10;
    const tenantId = await makeTenant(quota);

    const results = await Promise.allSettled(
      Array.from({ length: attempts }, () => usage.reserveAnswer(tenantId)),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );

    expect(fulfilled.length).toBe(quota);
    expect(rejected.length).toBe(attempts - quota);
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(HttpException);
      expect((r.reason as HttpException).getStatus()).toBe(402);
    }

    // The stored counter must reflect exactly the reserved amount -- never
    // more, regardless of how many concurrent requests raced for it.
    expect(await usedValue(tenantId)).toBe(quota);
  });
});
