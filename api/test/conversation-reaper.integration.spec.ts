import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { TenantProvisioningService } from '../src/tenancy/tenant-provisioning.service';
import { TenantDbService } from '../src/tenancy/tenant-db.service';
import { WebhooksService } from '../src/webhooks/webhooks.service';
import { ConversationReaperService } from '../src/conversations/conversation-reaper.service';
import type { MetricsService } from '../src/metrics/metrics.service';
import { runControlPlaneMigrations } from '../src/db/run-control-plane-migrations';
import * as schema from '../src/db/schema';
import { startPg } from './helpers/pg';

/**
 * Auto-close idle-conversation reaper (#40): exercises the cross-tenant sweep
 * against a real Postgres — per-project opt-in from `projects.settings`, the
 * idle threshold, status-transition to 'closed' (recording ended_at +
 * closed_reason), and tenant/project scoping.
 */
describe('conversation auto-close reaper', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let tenantDb: TenantDbService;
  let schemaName: string;
  let reaper: ConversationReaperService;
  let autoClosedInc: number;

  beforeAll(async () => {
    ({ container, pool } = await startPg());
    await runControlPlaneMigrations(pool);
    const prov = new TenantProvisioningService(pool, drizzle(pool, { schema }));
    ({ schemaName } = await prov.createTenant({ name: 'S', slug: 's' }));
    tenantDb = new TenantDbService(pool);

    autoClosedInc = 0;
    const metrics = {
      conversationsAutoClosedTotal: {
        inc: () => {
          autoClosedInc++;
        },
      },
    } as unknown as MetricsService;

    reaper = new ConversationReaperService(
      pool,
      tenantDb,
      new WebhooksService(tenantDb),
      metrics,
      60, // default idle threshold (minutes) when a project sets none
    );
  }, 180000);

  afterAll(async () => {
    reaper.stop();
    await pool.end();
    await container.stop();
  });

  async function createProject(
    settings: Record<string, unknown>,
  ): Promise<string> {
    return tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`INSERT INTO projects (name, settings)
            VALUES ('P', ${JSON.stringify(settings)}::jsonb)
            RETURNING id`,
      );
      return (r.rows[0] as { id: string }).id;
    });
  }

  /** Inserts a conversation whose updated_at is `ageMinutes` in the past. */
  async function insertConversation(
    projectId: string,
    status: string,
    ageMinutes: number,
  ): Promise<string> {
    return tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`INSERT INTO conversations (project_id, status, visitor_secret, updated_at)
            VALUES (${projectId}, ${status}, 'test-secret',
                    now() - (${ageMinutes}::text || ' minutes')::interval)
            RETURNING id`,
      );
      return (r.rows[0] as { id: string }).id;
    });
  }

  async function getConversation(id: string): Promise<{
    status: string;
    ended_at: string | null;
    closed_reason: string | null;
  }> {
    const r = await tenantDb.withTenant(schemaName, (db) =>
      db.execute(
        sql`SELECT status, ended_at, closed_reason FROM conversations WHERE id = ${id}`,
      ),
    );
    return r.rows[0] as {
      status: string;
      ended_at: string | null;
      closed_reason: string | null;
    };
  }

  it('closes idle open conversations for an opted-in project past its threshold', async () => {
    autoClosedInc = 0;
    const projectId = await createProject({
      autoCloseEnabled: true,
      autoCloseIdleMinutes: 30,
    });
    const idleBot = await insertConversation(projectId, 'bot', 45);
    const idleHandover = await insertConversation(projectId, 'handover', 90);
    const fresh = await insertConversation(projectId, 'bot', 5);

    const closed = await reaper.sweep();
    expect(closed).toBe(2);
    expect(autoClosedInc).toBe(2);

    const closedBot = await getConversation(idleBot);
    expect(closedBot.status).toBe('closed');
    expect(closedBot.ended_at).not.toBeNull();
    expect(closedBot.closed_reason).toBe('auto_idle');

    expect((await getConversation(idleHandover)).status).toBe('closed');
    // Below the threshold: left untouched.
    expect((await getConversation(fresh)).status).toBe('bot');
  });

  it('never closes an already-closed conversation (idempotent, no double count)', async () => {
    autoClosedInc = 0;
    const projectId = await createProject({
      autoCloseEnabled: true,
      autoCloseIdleMinutes: 30,
    });
    await insertConversation(projectId, 'bot', 60);

    expect(await reaper.sweep()).toBe(1);
    expect(autoClosedInc).toBe(1);
    // A second sweep finds nothing still open past threshold in this project.
    expect(await reaper.sweep()).toBe(0);
    expect(autoClosedInc).toBe(1);
  });

  it('leaves conversations untouched for a project that has not opted in', async () => {
    const projectId = await createProject({}); // no autoCloseEnabled
    const convo = await insertConversation(projectId, 'bot', 999);

    await reaper.sweep();
    expect((await getConversation(convo)).status).toBe('bot');
  });

  it('falls back to the reaper default idle threshold when the project sets none', async () => {
    // Default is 60 minutes. A 90-minute-idle conversation closes; a
    // 30-minute one does not.
    const projectId = await createProject({ autoCloseEnabled: true });
    const old = await insertConversation(projectId, 'bot', 90);
    const recent = await insertConversation(projectId, 'bot', 30);

    await reaper.sweep();
    expect((await getConversation(old)).status).toBe('closed');
    expect((await getConversation(recent)).status).toBe('bot');
  });
});
