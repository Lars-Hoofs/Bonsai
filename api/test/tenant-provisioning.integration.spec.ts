import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { TenantProvisioningService } from '../src/tenancy/tenant-provisioning.service';
import { runMigrations, CONTROLPLANE_DIR } from '../src/db/migrator';
import * as schema from '../src/db/schema';
import { startPg } from './helpers/pg';

describe('TenantProvisioningService', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let svc: TenantProvisioningService;
  beforeAll(async () => {
    ({ container, pool } = await startPg());
    await runMigrations(pool, {
      dir: CONTROLPLANE_DIR,
      schema: 'public',
      track: 'controlplane',
    });
    svc = new TenantProvisioningService(pool, drizzle(pool, { schema }));
  });
  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  it('creates tenant row, schema, and tenant tables', async () => {
    const t = await svc.createTenant({ name: 'Acme', slug: 'acme' });
    expect(t.schemaName).toMatch(/^t_[0-9a-f]{32}$/);
    const r = await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'projects'`,
      [t.schemaName],
    );
    expect(r.rowCount).toBe(1);
  });

  it('rejects duplicate slug', async () => {
    await expect(
      svc.createTenant({ name: 'Acme2', slug: 'acme' }),
    ).rejects.toThrow(/already exists/i);
  });
});
