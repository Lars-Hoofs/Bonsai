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

  it('cannot reach control-plane tables from a tenant-scoped connection (isolation by construction)', async () => {
    // `public` is excluded from the runtime search_path, so unqualified
    // references to control-plane tables must fail to resolve rather than
    // leak platform-wide data (all tenants' users, api key hashes, etc.).
    for (const table of ['tenants', 'users', 'api_keys', 'audit_log']) {
      // Drizzle wraps the pg error; the "relation does not exist" text is on
      // the cause. Assert on the full chain, and fail loudly if it resolves.
      let chain: string | undefined;
      try {
        await tenantDb.withTenant(a.schemaName, (db) =>
          db.execute(sql.raw(`SELECT * FROM ${table}`)),
        );
      } catch (err) {
        const e = err as { message?: string; cause?: { message?: string } };
        chain = `${e.message ?? ''} ${e.cause?.message ?? ''}`;
      }
      expect(chain).toBeDefined();
      expect(chain).toMatch(/does not exist/i);
    }
    // The tenant's own tables remain reachable unqualified.
    const own = await tenantDb.withTenant(a.schemaName, (db) =>
      db.execute(sql`SELECT count(*)::int AS c FROM projects`),
    );
    expect((own.rows[0] as { c: number }).c).toBeGreaterThanOrEqual(0);
  });
});
