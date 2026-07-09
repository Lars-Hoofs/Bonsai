import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { AuditService } from '../src/audit/audit.service';
import { TenantDbService } from '../src/tenancy/tenant-db.service';
import { TenantProvisioningService } from '../src/tenancy/tenant-provisioning.service';
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

  describe('record(entry, tx) — atomic with the caller transaction', () => {
    it('writes via a control-plane tx and commits together with the caller mutation', async () => {
      const db = drizzle(pool, { schema });
      await db.transaction(async (tx) => {
        await tx.insert(schema.tenants).values({
          name: 'TxCo',
          slug: 'tx-co',
          schemaName: 't_' + '0'.repeat(32),
        });
        await svc.record(
          { action: 'tenant.created', resource: 'tenant:tx-co' },
          tx,
        );
      });
      const r = await pool.query(
        `SELECT action, resource FROM audit_log WHERE resource = 'tenant:tx-co'`,
      );
      expect(r.rows).toEqual([
        { action: 'tenant.created', resource: 'tenant:tx-co' },
      ]);
    });

    it('rolls back the audit row together with the caller mutation on failure', async () => {
      const db = drizzle(pool, { schema });
      await expect(
        db.transaction(async (tx) => {
          await tx.insert(schema.tenants).values({
            name: 'DoomedCo',
            slug: 'doomed-co',
            schemaName: 't_' + '1'.repeat(32),
          });
          await svc.record(
            { action: 'tenant.created', resource: 'tenant:doomed-co' },
            tx,
          );
          throw new Error('boom: simulated post-mutation failure');
        }),
      ).rejects.toThrow(/boom/);

      const tenantRows = await pool.query(
        `SELECT 1 FROM tenants WHERE slug = 'doomed-co'`,
      );
      expect(tenantRows.rowCount).toBe(0);
      const auditRows = await pool.query(
        `SELECT 1 FROM audit_log WHERE resource = 'tenant:doomed-co'`,
      );
      expect(auditRows.rowCount).toBe(0);
    });

    it('writes to public.audit_log from inside a tenant-scoped transaction whose search_path excludes public', async () => {
      const provisioning = new TenantProvisioningService(
        pool,
        drizzle(pool, { schema }),
      );
      const tenantDb = new TenantDbService(pool);
      const tenant = await provisioning.createTenant({
        name: 'TenantScopedAudit',
        slug: 'tenant-scoped-audit',
      });

      await tenantDb.withTenant(tenant.schemaName, async (db) => {
        await db.execute(sql`INSERT INTO projects (name) VALUES ('proj-a')`);
        await svc.record(
          {
            tenantId: tenant.id,
            action: 'project.deleted',
            resource: 'project:proj-a',
          },
          db,
        );
      });

      const auditRows = await pool.query(
        `SELECT tenant_id, action, resource FROM audit_log WHERE resource = 'project:proj-a'`,
      );
      expect(auditRows.rows).toEqual([
        {
          tenant_id: tenant.id,
          action: 'project.deleted',
          resource: 'project:proj-a',
        },
      ]);
    });

    it('rolls back the tenant-schema mutation together with the audit row on failure inside withTenant', async () => {
      const provisioning = new TenantProvisioningService(
        pool,
        drizzle(pool, { schema }),
      );
      const tenantDb = new TenantDbService(pool);
      const tenant = await provisioning.createTenant({
        name: 'TenantScopedAuditRollback',
        slug: 'tenant-scoped-audit-rollback',
      });

      const insertResult = await tenantDb.withTenant(tenant.schemaName, (db) =>
        db.execute(
          sql`INSERT INTO projects (name) VALUES ('proj-doomed') RETURNING id`,
        ),
      );
      const projectId = (insertResult.rows[0] as { id: string }).id;

      await expect(
        tenantDb.withTenant(tenant.schemaName, async (db) => {
          await db.execute(sql`DELETE FROM projects WHERE id = ${projectId}`);
          await svc.record(
            {
              tenantId: tenant.id,
              action: 'project.deleted',
              resource: `project:${projectId}`,
            },
            db,
          );
          throw new Error('boom: forced failure after delete, before commit');
        }),
      ).rejects.toThrow(/boom/);

      // The DELETE must have rolled back: the project still exists.
      const remaining = await tenantDb.withTenant(tenant.schemaName, (db) =>
        db.execute(sql`SELECT id FROM projects WHERE id = ${projectId}`),
      );
      expect(remaining.rows).toHaveLength(1);

      // And no audit row must have been written either.
      const auditRows = await pool.query(
        `SELECT 1 FROM audit_log WHERE resource = $1`,
        [`project:${projectId}`],
      );
      expect(auditRows.rowCount).toBe(0);
    });
  });
});
