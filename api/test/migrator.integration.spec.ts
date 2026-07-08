import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  runMigrations,
  CONTROLPLANE_DIR,
  TENANT_DIR,
} from '../src/db/migrator';
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
    expect(first).toEqual([
      '0001_init.sql',
      '0002_vector.sql',
      '0003_usage.sql',
      '0004_user_email_unique.sql',
    ]);
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

  describe('schema name validation', () => {
    it('rejects a schema name with a SQL injection attempt', async () => {
      await expect(
        runMigrations(pool, {
          dir: CONTROLPLANE_DIR,
          schema: 'public; DROP TABLE x',
          track: 'evil',
        }),
      ).rejects.toThrow(/Invalid schema name/);
    });

    it('rejects a malformed tenant schema name', async () => {
      await expect(
        runMigrations(pool, {
          dir: CONTROLPLANE_DIR,
          schema: 't_xyz',
          track: 'evil-tenant',
        }),
      ).rejects.toThrow(/Invalid schema name/);
    });
  });

  it('rolls back the failing file but keeps prior committed files applied', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-'));
    writeFileSync(
      join(dir, '0001_ok.sql'),
      'CREATE TABLE roll_ok (id int);',
      'utf8',
    );
    writeFileSync(
      join(dir, '0002_bad.sql'),
      'CREATE TABLE roll_bad (id int); SELECT invalid_function_xyz();',
      'utf8',
    );
    const track = `rollback-${Date.now()}`;

    await expect(
      runMigrations(pool, { dir, schema: 'public', track }),
    ).rejects.toThrow();

    const okExists = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'roll_ok') AS exists`,
    );
    expect(okExists.rows[0]?.exists).toBe(true);

    const badExists = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'roll_bad') AS exists`,
    );
    expect(badExists.rows[0]?.exists).toBe(false);

    const rows = await pool.query<{ version: string }>(
      'SELECT version FROM public.migrations WHERE track = $1 ORDER BY version',
      [track],
    );
    expect(rows.rows.map((r) => r.version)).toEqual(['0001_ok.sql']);
  });

  it('applies tenant migrations under a t_<hex> schema', async () => {
    const schema = 't_' + 'b'.repeat(32);
    await pool.query(`CREATE SCHEMA "${schema}"`);

    await runMigrations(pool, {
      dir: TENANT_DIR,
      schema,
      track: `tenant:${schema}`,
    });

    const r = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'projects'`,
      [schema],
    );
    expect(r.rows.map((row) => row.table_name)).toEqual(['projects']);
  });

  it('serializes concurrent runners for the same track via advisory lock', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-concurrent-'));
    writeFileSync(
      join(dir, '0001_concurrent.sql'),
      'CREATE TABLE concurrent_once (id int);',
      'utf8',
    );
    const track = `concurrent-${Date.now()}`;

    const [a, b] = await Promise.all([
      runMigrations(pool, { dir, schema: 'public', track }),
      runMigrations(pool, { dir, schema: 'public', track }),
    ]);

    const combined = [...a, ...b];
    expect(combined).toEqual(['0001_concurrent.sql']);

    const rows = await pool.query(
      'SELECT version FROM public.migrations WHERE track = $1',
      [track],
    );
    expect(rows.rowCount).toBe(1);
  });
});
