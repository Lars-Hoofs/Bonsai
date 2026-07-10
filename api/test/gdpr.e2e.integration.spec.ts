import { INestApplication } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPg } from './helpers/pg';
import { buildTestApp } from './helpers/app';
import { TestIdp } from './helpers/oidc';
import { TenantDbService } from '../src/tenancy/tenant-db.service';
import { GdprService } from '../src/gdpr/gdpr.service';

interface IdBody {
  id: string;
}

/**
 * End-to-end coverage for GDPR export + right-to-erasure + retention purge
 * (#47): admin-only RBAC, a real export bundle, erasure actually removing
 * the rows, and the retention auto-purge deleting only stale conversations.
 */
describe('gdpr e2e (export, erasure, retention purge, RBAC)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let idp: TestIdp;
  let adminToken: string;
  let editorToken: string;
  let tenantId: string;
  let projectId: string;
  let tenantSchema: string;
  let tenantDb: TenantDbService;
  let gdpr: GdprService;

  const authAdmin = (): { Authorization: string } => ({
    Authorization: `Bearer ${adminToken}`,
  });
  const authEditor = (): { Authorization: string } => ({
    Authorization: `Bearer ${editorToken}`,
  });
  const base = (): string =>
    `/v1/tenants/${tenantId}/projects/${projectId}/gdpr`;

  /** Seeds a conversation (with a message + citation + feedback + handover)
   * for a visitor, optionally back-dating its `updated_at` for purge tests. */
  async function seedConversation(
    visitorId: string,
    opts: { updatedDaysAgo?: number } = {},
  ): Promise<string> {
    return tenantDb.withTenant(tenantSchema, async (db) => {
      const conv = (
        await db.execute(sql`
          INSERT INTO conversations (project_id, visitor_id, visitor_secret)
          VALUES (${projectId}, ${visitorId}, 'secret-value')
          RETURNING id`)
      ).rows[0] as { id: string };
      const conversationId = conv.id;

      if (opts.updatedDaysAgo !== undefined) {
        await db.execute(sql`
          UPDATE conversations
          SET updated_at = now() - (${opts.updatedDaysAgo}::text || ' days')::interval
          WHERE id = ${conversationId}`);
      }

      const msg = (
        await db.execute(sql`
          INSERT INTO messages (conversation_id, role, content)
          VALUES (${conversationId}, 'visitor', 'my personal question')
          RETURNING id`)
      ).rows[0] as { id: string };

      await db.execute(sql`
        INSERT INTO message_citations
          (message_id, ordinal, chunk_id, document_id, document_title, source_id)
        VALUES (${msg.id}, 1, gen_random_uuid(), gen_random_uuid(), 'Doc', gen_random_uuid())`);
      await db.execute(sql`
        INSERT INTO message_feedback (message_id, rating)
        VALUES (${msg.id}, 'up')`);
      await db.execute(sql`
        INSERT INTO handovers (conversation_id, reason)
        VALUES (${conversationId}, 'human requested')`);

      return conversationId;
    });
  }

  async function countConversations(visitorId: string): Promise<number> {
    return tenantDb.withTenant(tenantSchema, async (db) => {
      const r = await db.execute(sql`
        SELECT count(*)::int AS n FROM conversations
        WHERE project_id = ${projectId} AND visitor_id = ${visitorId}`);
      return (r.rows[0] as { n: number }).n;
    });
  }

  async function countMessages(conversationId: string): Promise<number> {
    return tenantDb.withTenant(tenantSchema, async (db) => {
      const r = await db.execute(sql`
        SELECT count(*)::int AS n FROM messages
        WHERE conversation_id = ${conversationId}`);
      return (r.rows[0] as { n: number }).n;
    });
  }

  beforeAll(async () => {
    ({ container, pool } = await startPg());
    ({ app, idp } = await buildTestApp(pool));
    tenantDb = new TenantDbService(pool);
    gdpr = app.get(GdprService);

    adminToken = await idp.sign({ sub: 'oidc|admin', email: 'admin@acme.eu' });
    editorToken = await idp.sign({
      sub: 'oidc|editor',
      email: 'editor@acme.eu',
    });

    const t = await request(app.getHttpServer())
      .post('/v1/tenants')
      .set(authAdmin())
      .send({ name: 'Acme', slug: 'acme-gdpr' })
      .expect(201);
    tenantId = (t.body as IdBody).id;

    const p = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/projects`)
      .set(authAdmin())
      .send({ name: 'Bot', defaultLanguage: 'nl' })
      .expect(201);
    projectId = (p.body as IdBody).id;

    // Register the editor (second user) then attach an editor membership —
    // enough to exercise "authenticated but not admin" for the RBAC checks.
    await request(app.getHttpServer())
      .get('/v1/tenants')
      .set(authEditor())
      .expect(200);
    await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/members`)
      .set(authAdmin())
      .send({ email: 'editor@acme.eu', role: 'editor' })
      .expect(201);

    const tenantRow = await pool.query<{ schema_name: string }>(
      'SELECT schema_name FROM tenants WHERE id = $1',
      [tenantId],
    );
    tenantSchema = tenantRow.rows[0].schema_name;
  }, 120000);

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('exports a subject bundle with nested conversations/messages/citations/feedback', async () => {
    await seedConversation('subject-export');

    const res = await request(app.getHttpServer())
      .get(`${base()}/export`)
      .query({ visitorId: 'subject-export' })
      .set(authAdmin())
      .expect(200);

    expect(res.headers['content-disposition']).toContain('attachment');
    const bundle = res.body as {
      subject: { visitorId: string; tenantId: string };
      counts: { conversations: number; messages: number };
      conversations: Array<{
        messages: Array<{
          content: string;
          citations: unknown[];
          feedback: unknown[];
        }>;
        handovers: unknown[];
      }>;
    };
    expect(bundle.subject.visitorId).toBe('subject-export');
    expect(bundle.subject.tenantId).toBe(tenantId);
    expect(bundle.counts.conversations).toBe(1);
    expect(bundle.counts.messages).toBe(1);
    const conv = bundle.conversations[0];
    expect(conv.messages[0].content).toBe('my personal question');
    expect(conv.messages[0].citations).toHaveLength(1);
    expect(conv.messages[0].feedback).toHaveLength(1);
    expect(conv.handovers).toHaveLength(1);
  });

  it('returns 404 exporting a subject with no data', async () => {
    await request(app.getHttpServer())
      .get(`${base()}/export`)
      .query({ visitorId: 'ghost' })
      .set(authAdmin())
      .expect(404);
  });

  it('erases a subject: data is actually gone (conversation + cascaded rows)', async () => {
    const conversationId = await seedConversation('subject-erase');
    expect(await countConversations('subject-erase')).toBe(1);
    expect(await countMessages(conversationId)).toBe(1);

    const res = await request(app.getHttpServer())
      .delete(base())
      .query({ visitorId: 'subject-erase' })
      .set(authAdmin())
      .expect(200);
    expect(
      (res.body as { conversationsDeleted: number }).conversationsDeleted,
    ).toBe(1);

    // Verify the personal data is irreversibly gone, incl. cascaded messages.
    expect(await countConversations('subject-erase')).toBe(0);
    expect(await countMessages(conversationId)).toBe(0);

    // A subsequent export must now 404 — nothing left to export.
    await request(app.getHttpServer())
      .get(`${base()}/export`)
      .query({ visitorId: 'subject-erase' })
      .set(authAdmin())
      .expect(404);
  });

  it('erasing an unknown subject returns 404', async () => {
    await request(app.getHttpServer())
      .delete(base())
      .query({ visitorId: 'never-existed' })
      .set(authAdmin())
      .expect(404);
  });

  it('records audit rows for export and erasure', async () => {
    await seedConversation('subject-audit');
    await request(app.getHttpServer())
      .get(`${base()}/export`)
      .query({ visitorId: 'subject-audit' })
      .set(authAdmin())
      .expect(200);
    await request(app.getHttpServer())
      .delete(base())
      .query({ visitorId: 'subject-audit' })
      .set(authAdmin())
      .expect(200);

    const audit = await pool.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE resource = $1 ORDER BY created_at`,
      ['visitor:subject-audit'],
    );
    const actions = audit.rows.map((r) => r.action);
    expect(actions).toContain('gdpr.export');
    expect(actions).toContain('gdpr.erasure');
  });

  it('RBAC: a non-admin (editor) cannot export or erase', async () => {
    await seedConversation('subject-rbac');

    await request(app.getHttpServer())
      .get(`${base()}/export`)
      .query({ visitorId: 'subject-rbac' })
      .set(authEditor())
      .expect(403);

    await request(app.getHttpServer())
      .delete(base())
      .query({ visitorId: 'subject-rbac' })
      .set(authEditor())
      .expect(403);

    // Editor's forbidden erase must not have touched the data.
    expect(await countConversations('subject-rbac')).toBe(1);
  });

  it('RBAC: unauthenticated requests are rejected', async () => {
    await request(app.getHttpServer())
      .get(`${base()}/export`)
      .query({ visitorId: 'subject-rbac' })
      .expect(401);
  });

  it('retention purge deletes only conversations older than the window', async () => {
    // A fresh conversation and an old one for two different visitors.
    const oldConversation = await seedConversation('subject-old', {
      updatedDaysAgo: 40,
    });
    await seedConversation('subject-fresh', { updatedDaysAgo: 1 });

    // Set a 30-day retention window on the project (admin, via projects PATCH).
    await request(app.getHttpServer())
      .patch(`/v1/tenants/${tenantId}/projects/${projectId}`)
      .set(authAdmin())
      .send({ retentionDays: 30 })
      .expect(200);

    const results = await gdpr.purgeExpired();
    const forProject = results.filter((r) => r.projectId === projectId);
    const purged = forProject.reduce((n, r) => n + r.conversationsDeleted, 0);
    expect(purged).toBeGreaterThanOrEqual(1);

    // The old conversation is gone; the fresh one survives.
    expect(await countMessages(oldConversation)).toBe(0);
    expect(await countConversations('subject-old')).toBe(0);
    expect(await countConversations('subject-fresh')).toBe(1);

    const audit = await pool.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE resource = $1 AND action = 'gdpr.purge'`,
      [`project:${projectId}`],
    );
    expect(audit.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('retention purge is a no-op for a project with no window configured', async () => {
    // New project, no retention_days set; an old conversation must survive.
    const p = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/projects`)
      .set(authAdmin())
      .send({ name: 'NoRetention' })
      .expect(201);
    const otherProjectId = (p.body as IdBody).id;

    const conversationId = await tenantDb.withTenant(
      tenantSchema,
      async (db) => {
        const r = await db.execute(sql`
          INSERT INTO conversations (project_id, visitor_id, visitor_secret, updated_at)
          VALUES (${otherProjectId}, 'keep-me', 'x', now() - interval '999 days')
          RETURNING id`);
        return (r.rows[0] as { id: string }).id;
      },
    );

    await gdpr.purgeExpired();

    const survived = await tenantDb.withTenant(tenantSchema, async (db) => {
      const r = await db.execute(sql`
        SELECT count(*)::int AS n FROM conversations WHERE id = ${conversationId}`);
      return (r.rows[0] as { n: number }).n;
    });
    expect(survived).toBe(1);
  });
});
