import { ConflictException } from '@nestjs/common';
import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { TenantProvisioningService } from '../src/tenancy/tenant-provisioning.service';
import { runMigrations, CONTROLPLANE_DIR } from '../src/db/migrator';
import * as schema from '../src/db/schema';
import { tenants } from '../src/db/schema';
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

  // Tenant schemas NOT referenced by any tenant row are orphans; healthy = 0.
  const countOrphanSchemas = async (): Promise<number> => {
    const r = await pool.query(
      `SELECT count(*)::int AS count
       FROM information_schema.schemata
       WHERE schema_name LIKE 't\\_%'
         AND schema_name NOT IN (SELECT schema_name FROM public.tenants)`,
    );
    return (r.rows[0] as { count: number }).count;
  };

  it('creates tenant row, schema, and tenant tables', async () => {
    const t = await svc.createTenant({ name: 'Acme', slug: 'acme' });
    expect(t.schemaName).toMatch(/^t_[0-9a-f]{32}$/);
    const r = await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'projects'`,
      [t.schemaName],
    );
    expect(r.rowCount).toBe(1);
    expect(await countOrphanSchemas()).toBe(0);
  });

  it('rejects duplicate slug', async () => {
    await expect(
      svc.createTenant({ name: 'Acme2', slug: 'acme' }),
    ).rejects.toThrow(/already exists/i);
  });

  it('resolves exactly one winner when two concurrent calls race on the same slug', async () => {
    const results = await Promise.allSettled([
      svc.createTenant({ name: 'X', slug: 'race' }),
      svc.createTenant({ name: 'Y', slug: 'race' }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const rejectedReason = rejected[0].reason as unknown;
    const isConflict =
      rejectedReason instanceof ConflictException ||
      /already exists/i.test(String(rejectedReason));
    expect(isConflict).toBe(true);

    const rows = await pool.query(
      `SELECT count(*)::int AS count FROM public.tenants WHERE slug = $1`,
      ['race'],
    );
    expect((rows.rows[0] as { count: number }).count).toBe(1);
  });

  it('drops the schema and writes no tenant row when migration fails after schema creation; the slug stays reusable', async () => {
    const failing = new TenantProvisioningService(
      pool,
      drizzle(pool, { schema }),
      () => Promise.reject(new Error('boom: simulated migration failure')),
    );

    await expect(
      failing.createTenant({ name: 'Broken', slug: 'broken-tenant' }),
    ).rejects.toThrow(/boom: simulated migration failure/);

    const rows = await pool.query(
      `SELECT count(*)::int AS count FROM public.tenants WHERE slug = $1`,
      ['broken-tenant'],
    );
    expect((rows.rows[0] as { count: number }).count).toBe(0);
    expect(await countOrphanSchemas()).toBe(0);

    const retried = await svc.createTenant({
      name: 'Broken Retry',
      slug: 'broken-tenant',
    });
    expect(retried.schemaName).toMatch(/^t_[0-9a-f]{32}$/);
    const [persisted] = await drizzle(pool, { schema })
      .select()
      .from(tenants)
      .where(eq(tenants.slug, 'broken-tenant'));
    expect(persisted.schemaName).toBe(retried.schemaName);
  });
});
