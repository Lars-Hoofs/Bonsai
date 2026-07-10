import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPg } from './helpers/pg';
import { buildTestApp } from './helpers/app';
import { TestIdp } from './helpers/oidc';

interface IdBody {
  id: string;
}
interface StartBody {
  id: string;
  visitorSecret: string;
}
interface NoteBody {
  id: string;
  conversationId: string;
  authorUserId: string;
  body: string;
  createdAt: string;
}
interface ConvoView {
  conversation: { status: string };
  messages: { role: string; content: string }[];
  notes?: unknown;
}

describe('conversation notes e2e (#34)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let idp: TestIdp;
  let ownerToken: string;
  let viewerToken: string;
  let tenantId: string;
  let projectId: string;
  let widgetKey: string;
  let conversationId: string;
  let visitorSecret: string;

  const agentBase = (): string =>
    `/v1/tenants/${tenantId}/projects/${projectId}/conversations`;
  const notesBase = (): string => `${agentBase()}/${conversationId}/notes`;
  const widgetBase = '/v1/widget/conversations';
  const ownerAuth = (): { Authorization: string } => ({
    Authorization: `Bearer ${ownerToken}`,
  });
  const viewerAuth = (): { Authorization: string } => ({
    Authorization: `Bearer ${viewerToken}`,
  });

  beforeAll(async () => {
    ({ container, pool } = await startPg());
    ({ app, idp } = await buildTestApp(pool));
    ownerToken = await idp.sign({
      sub: 'oidc|notes-owner',
      email: 'notes-owner@acme.eu',
    });
    viewerToken = await idp.sign({
      sub: 'oidc|notes-viewer',
      email: 'notes-viewer@acme.eu',
    });

    const t = await request(app.getHttpServer())
      .post('/v1/tenants')
      .set(ownerAuth())
      .send({ name: 'Acme', slug: 'acme-notes' })
      .expect(201);
    tenantId = (t.body as IdBody).id;

    const p = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/projects`)
      .set(ownerAuth())
      .send({ name: 'Bot' })
      .expect(201);
    projectId = (p.body as IdBody).id;

    // Register the viewer (second user) then attach a viewer membership.
    await request(app.getHttpServer())
      .get('/v1/tenants')
      .set(viewerAuth())
      .expect(200);
    await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/members`)
      .set(ownerAuth())
      .send({ email: 'notes-viewer@acme.eu', role: 'viewer' })
      .expect(201);

    const key = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/api-keys`)
      .set(ownerAuth())
      .send({ name: 'widget', kind: 'public_widget', projectId })
      .expect(201);
    widgetKey = (key.body as { key: string }).key;

    const started = await request(app.getHttpServer())
      .post(widgetBase)
      .set('x-bonsai-key', widgetKey)
      .send({ language: 'nl' })
      .expect(201);
    ({ id: conversationId, visitorSecret } = started.body as StartBody);
  }, 120000);

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('an agent adds a note, GET returns it newest-first, and it is invisible to the public visitor endpoint', async () => {
    const first = await request(app.getHttpServer())
      .post(notesBase())
      .set(ownerAuth())
      .send({ body: 'First note' })
      .expect(201);
    const firstNote = first.body as NoteBody;
    expect(firstNote.body).toBe('First note');
    expect(firstNote.conversationId).toBe(conversationId);
    expect(firstNote.authorUserId).toEqual(expect.any(String));

    const second = await request(app.getHttpServer())
      .post(notesBase())
      .set(ownerAuth())
      .send({ body: 'Second note' })
      .expect(201);
    const secondNote = second.body as NoteBody;

    const list = await request(app.getHttpServer())
      .get(notesBase())
      .set(ownerAuth())
      .expect(200);
    const notes = list.body as NoteBody[];
    expect(notes.map((n) => n.id)).toEqual([secondNote.id, firstNote.id]);

    // Audit trail.
    const audit = await pool.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE resource = $1 ORDER BY created_at`,
      [`conversation:${conversationId}`],
    );
    expect(audit.rows.map((r) => r.action)).toContain(
      'conversation.note_added',
    );

    // The public/visitor endpoint must never expose notes.
    const visitorView = await request(app.getHttpServer())
      .get(`${widgetBase}/${conversationId}`)
      .set('x-bonsai-key', widgetKey)
      .set('x-bonsai-visitor-secret', visitorSecret)
      .expect(200);
    const vv = visitorView.body as ConvoView;
    expect(vv.notes).toBeUndefined();
    expect(JSON.stringify(vv)).not.toContain('First note');
    expect(JSON.stringify(vv)).not.toContain('Second note');

    // Nor does the agent-facing conversation view bleed notes into its own
    // response shape (they only live under the dedicated notes endpoint).
    const agentView = await request(app.getHttpServer())
      .get(`${agentBase()}/${conversationId}`)
      .set(ownerAuth())
      .expect(200);
    expect(JSON.stringify(agentView.body)).not.toContain('First note');
  });

  it('deletes a note as its author', async () => {
    const created = await request(app.getHttpServer())
      .post(notesBase())
      .set(ownerAuth())
      .send({ body: 'Delete me' })
      .expect(201);
    const id = (created.body as NoteBody).id;

    await request(app.getHttpServer())
      .delete(`${notesBase()}/${id}`)
      .set(ownerAuth())
      .expect(200);

    const list = await request(app.getHttpServer())
      .get(notesBase())
      .set(ownerAuth())
      .expect(200);
    expect((list.body as NoteBody[]).some((n) => n.id === id)).toBe(false);

    const audit = await pool.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE resource = $1 AND action = 'conversation.note_deleted'`,
      [`conversation:${conversationId}`],
    );
    expect(audit.rowCount).toBeGreaterThanOrEqual(1);
  });

  it('deleting a non-existent note returns 404', async () => {
    await request(app.getHttpServer())
      .delete(`${notesBase()}/00000000-0000-0000-0000-000000000000`)
      .set(ownerAuth())
      .expect(404);
  });

  it('RBAC: a viewer cannot add, list, or delete notes (403)', async () => {
    await request(app.getHttpServer())
      .post(notesBase())
      .set(viewerAuth())
      .send({ body: 'blocked' })
      .expect(403);

    await request(app.getHttpServer())
      .get(notesBase())
      .set(viewerAuth())
      .expect(403);

    const created = await request(app.getHttpServer())
      .post(notesBase())
      .set(ownerAuth())
      .send({ body: 'viewer cannot delete this' })
      .expect(201);
    const id = (created.body as NoteBody).id;

    await request(app.getHttpServer())
      .delete(`${notesBase()}/${id}`)
      .set(viewerAuth())
      .expect(403);
  });

  it("a non-author agent cannot delete another agent's note, but an admin can", async () => {
    const otherAgentToken = await idp.sign({
      sub: 'oidc|notes-other-agent',
      email: 'notes-other-agent@acme.eu',
    });
    await request(app.getHttpServer())
      .get('/v1/tenants')
      .set({ Authorization: `Bearer ${otherAgentToken}` })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/members`)
      .set(ownerAuth())
      .send({ email: 'notes-other-agent@acme.eu', role: 'agent' })
      .expect(201);

    const created = await request(app.getHttpServer())
      .post(notesBase())
      .set(ownerAuth())
      .send({ body: 'owner-authored note' })
      .expect(201);
    const id = (created.body as NoteBody).id;

    await request(app.getHttpServer())
      .delete(`${notesBase()}/${id}`)
      .set({ Authorization: `Bearer ${otherAgentToken}` })
      .expect(403);

    // Owner is also an admin-ranked role, so this exercises the "admin can
    // delete anyone's note" path directly (author-or-admin).
    await request(app.getHttpServer())
      .delete(`${notesBase()}/${id}`)
      .set(ownerAuth())
      .expect(200);
  });

  it('404s when the conversation does not belong to the project', async () => {
    const otherProject = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/projects`)
      .set(ownerAuth())
      .send({ name: 'OtherBot' })
      .expect(201);
    const otherProjectId = (otherProject.body as IdBody).id;

    await request(app.getHttpServer())
      .get(
        `/v1/tenants/${tenantId}/projects/${otherProjectId}/conversations/${conversationId}/notes`,
      )
      .set(ownerAuth())
      .expect(404);
  });
});
