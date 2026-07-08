import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { AuditService } from '../src/audit/audit.service';
import { runMigrations, CONTROLPLANE_DIR } from '../src/db/migrator';
import * as schema from '../src/db/schema';
import { startPg } from './helpers/pg';

describe('AuditService', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let svc: AuditService;
  beforeAll(async () => {
    ({ container, pool } = await startPg());
    await runMigrations(pool, {
      dir: CONTROLPLANE_DIR,
      schema: 'public',
      track: 'controlplane',
    });
    svc = new AuditService(drizzle(pool, { schema }));
  });
  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  it('records an audit entry', async () => {
    await svc.record({
      action: 'tenant.created',
      resource: 'tenant:x',
      metadata: { slug: 'x' },
    });
    const r = await pool.query(
      `SELECT action, resource, metadata FROM audit_log`,
    );
    expect(r.rows).toEqual([
      {
        action: 'tenant.created',
        resource: 'tenant:x',
        metadata: { slug: 'x' },
      },
    ]);
  });

  it('audit_log rejects UPDATE and DELETE (append-only)', async () => {
    await expect(
      pool.query(`UPDATE audit_log SET action = 'tampered'`),
    ).rejects.toThrow(/append-only/);
    await expect(pool.query(`DELETE FROM audit_log`)).rejects.toThrow(
      /append-only/,
    );
  });
});
