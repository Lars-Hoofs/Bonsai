import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runMigrations, CONTROLPLANE_DIR } from '../src/db/migrator';
import { startPg } from './helpers/pg';

describe('migrator', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  beforeAll(async () => ({ container, pool } = await startPg()));
  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  it('applies control-plane migrations and is idempotent', async () => {
    const first = await runMigrations(pool, {
      dir: CONTROLPLANE_DIR,
      schema: 'public',
      track: 'controlplane',
    });
    expect(first).toEqual(['0001_init.sql']);
    const second = await runMigrations(pool, {
      dir: CONTROLPLANE_DIR,
      schema: 'public',
      track: 'controlplane',
    });
    expect(second).toEqual([]);
    const r = await pool.query<{ count: string }>(
      `SELECT count(*) FROM tenants`,
    );
    expect(r.rows[0]?.count).toBe('0');
  });
});
