import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import * as schema from '../src/db/schema';
import { runMigrations, CONTROLPLANE_DIR } from '../src/db/migrator';
import { startPg } from './helpers/pg';

describe('control-plane schema', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  beforeAll(async () => {
    ({ container, pool } = await startPg());
    await runMigrations(pool, {
      dir: CONTROLPLANE_DIR,
      schema: 'public',
      track: 'controlplane',
    });
  });
  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  it('inserts and reads a tenant via drizzle', async () => {
    const db = drizzle(pool, { schema });
    const [t] = await db
      .insert(schema.tenants)
      .values({ name: 'Acme', slug: 'acme', schemaName: 't_' + 'a'.repeat(32) })
      .returning();
    expect(t.plan).toBe('starter');
    expect(t.dataRegion).toBe('eu');
  });
});
