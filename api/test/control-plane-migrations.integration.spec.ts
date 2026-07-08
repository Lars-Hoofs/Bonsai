import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runControlPlaneMigrations } from '../src/db/run-control-plane-migrations';
import { startPg } from './helpers/pg';

describe('runControlPlaneMigrations', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  beforeAll(async () => ({ container, pool } = await startPg()));
  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  it('applies control-plane migrations against a fresh database and is idempotent', async () => {
    const applied = await runControlPlaneMigrations(pool);
    expect(applied.length).toBeGreaterThan(0);

    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [['tenants', 'users', 'memberships', 'api_keys', 'audit_log']],
    );
    const found = tables.rows.map((r) => r.table_name).sort();
    expect(found).toEqual(
      ['api_keys', 'audit_log', 'memberships', 'tenants', 'users'].sort(),
    );

    const second = await runControlPlaneMigrations(pool);
    expect(second).toEqual([]);
  });
});
