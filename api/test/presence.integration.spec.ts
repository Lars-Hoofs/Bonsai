import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PresenceService } from '../src/presence/presence.service';
import { TenantProvisioningService } from '../src/tenancy/tenant-provisioning.service';
import { runMigrations, CONTROLPLANE_DIR } from '../src/db/migrator';
import * as schema from '../src/db/schema';
import { startPg } from './helpers/pg';

describe('PresenceService', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let svc: PresenceService;
  let provisioning: TenantProvisioningService;

  beforeAll(async () => {
    ({ container, pool } = await startPg());
    await runMigrations(pool, {
      dir: CONTROLPLANE_DIR,
      schema: 'public',
      track: 'controlplane',
    });
    const db = drizzle(pool, { schema });
    svc = new PresenceService(db);
    provisioning = new TenantProvisioningService(pool, db);
  });

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  async function makeTenant(slug: string): Promise<string> {
    const t = await provisioning.createTenant({ name: slug, slug });
    return t.id;
  }

  async function makeUser(email: string): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO users (oidc_subject, email) VALUES ($1, $2) RETURNING id`,
      [`oidc|${email}`, email],
    );
    return r.rows[0].id;
  }

  async function addMembership(
    tenantId: string,
    userId: string,
    role: string,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)`,
      [tenantId, userId, role],
    );
  }

  it('setPresence upserts status + last_seen_at, and is idempotent on repeat calls', async () => {
    const tenantId = await makeTenant('presence-upsert');
    const userId = await makeUser('upsert@example.com');
    await addMembership(tenantId, userId, 'agent');

    await svc.setPresence(tenantId, userId, 'available');
    let row = await pool.query<{ status: string }>(
      `SELECT status FROM agent_presence WHERE tenant_id=$1 AND user_id=$2`,
      [tenantId, userId],
    );
    expect(row.rows[0].status).toBe('available');

    await svc.setPresence(tenantId, userId, 'away');
    row = await pool.query<{ status: string }>(
      `SELECT status FROM agent_presence WHERE tenant_id=$1 AND user_id=$2`,
      [tenantId, userId],
    );
    expect(row.rows[0].status).toBe('away');

    const count = await pool.query<{ count: string }>(
      `SELECT count(*) FROM agent_presence WHERE tenant_id=$1 AND user_id=$2`,
      [tenantId, userId],
    );
    expect(Number(count.rows[0].count)).toBe(1);
  });

  it('listAvailable returns only users who are available, fresh, and >= agent role in this tenant', async () => {
    const tenantId = await makeTenant('presence-list');
    const available = await makeUser('available@example.com');
    const away = await makeUser('away@example.com');
    const viewer = await makeUser('viewer@example.com');
    const stale = await makeUser('stale@example.com');
    const otherTenantAgent = await makeUser('other-tenant@example.com');

    await addMembership(tenantId, available, 'agent');
    await addMembership(tenantId, away, 'agent');
    await addMembership(tenantId, viewer, 'viewer');
    await addMembership(tenantId, stale, 'agent');

    const otherTenantId = await makeTenant('presence-list-other');
    await addMembership(otherTenantId, otherTenantAgent, 'agent');

    await svc.setPresence(tenantId, available, 'available');
    await svc.setPresence(tenantId, away, 'away');
    await svc.setPresence(tenantId, viewer, 'available');
    await svc.setPresence(otherTenantId, otherTenantAgent, 'available');

    // Backdate `stale`'s last_seen_at beyond the freshness window.
    await svc.setPresence(tenantId, stale, 'available');
    await pool.query(
      `UPDATE agent_presence SET last_seen_at = now() - interval '10 minutes'
       WHERE tenant_id=$1 AND user_id=$2`,
      [tenantId, stale],
    );

    const result = await svc.listAvailable(tenantId);
    expect(result).toEqual([available]);
  });

  it('listAvailable returns [] when no one is available', async () => {
    const tenantId = await makeTenant('presence-none');
    const result = await svc.listAvailable(tenantId);
    expect(result).toEqual([]);
  });
});
