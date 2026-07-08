import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { TenantProvisioningService } from '../src/tenancy/tenant-provisioning.service';
import { TenantDbService } from '../src/tenancy/tenant-db.service';
import { runMigrations, CONTROLPLANE_DIR } from '../src/db/migrator';
import * as schema from '../src/db/schema';
import { startPg } from './helpers/pg';

describe('tenant isolation', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let tenantDb: TenantDbService;
  let a: { schemaName: string };
  let b: { schemaName: string };

  beforeAll(async () => {
    ({ container, pool } = await startPg());
    await runMigrations(pool, {
      dir: CONTROLPLANE_DIR,
      schema: 'public',
      track: 'controlplane',
    });
    const prov = new TenantProvisioningService(pool, drizzle(pool, { schema }));
    a = await prov.createTenant({ name: 'A', slug: 'a' });
    b = await prov.createTenant({ name: 'B', slug: 'b' });
    tenantDb = new TenantDbService(pool);
  });
  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  it('data written in tenant A is invisible in tenant B', async () => {
    await tenantDb.withTenant(a.schemaName, async (db) => {
      await db.execute(sql`INSERT INTO projects (name) VALUES ('secret-a')`);
    });
    const inB = await tenantDb.withTenant(b.schemaName, (db) =>
      db.execute(sql`SELECT * FROM projects`),
    );
    expect(inB.rows).toHaveLength(0);
    const inA = await tenantDb.withTenant(a.schemaName, (db) =>
      db.execute(sql`SELECT name FROM projects`),
    );
    expect(inA.rows).toEqual([{ name: 'secret-a' }]);
  });

  it('rolls back on error', async () => {
    await expect(
      tenantDb.withTenant(a.schemaName, async (db) => {
        await db.execute(sql`INSERT INTO projects (name) VALUES ('doomed')`);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const rows = await tenantDb.withTenant(a.schemaName, (db) =>
      db.execute(sql`SELECT * FROM projects WHERE name = 'doomed'`),
    );
    expect(rows.rows).toHaveLength(0);
  });

  it('rejects malformed schema names', async () => {
    await expect(
      tenantDb.withTenant('public; DROP TABLE tenants;--', () =>
        Promise.resolve(undefined),
      ),
    ).rejects.toThrow('Invalid tenant schema');
  });
});
