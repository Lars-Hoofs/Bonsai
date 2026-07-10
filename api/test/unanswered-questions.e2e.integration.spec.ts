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
  projectId: string;
  status: string;
  visitorSecret: string;
}
interface ConversationDetail {
  conversation: { id: string };
  messages: { id: string; role: string; content: string }[];
}
interface UnansweredRow {
  id: string;
  question: string;
  reason: 'refused' | 'visitor_no';
  resolved: boolean;
  messageId: string | null;
}
interface SuggestionsBody {
  analyzed: number;
  suggestions: {
    label: string;
    size: number;
    questionIds: string[];
    examples: string[];
  }[];
}

/**
 * #32 (capture) + #41 (clustering) end-to-end. The project starts with an
 * EMPTY knowledge base, so every bot answer is a refusal — which exercises
 * both capture paths (auto 'refused' + explicit visitor 'no') and gives the
 * clustering endpoint real rows to group.
 */
describe('unanswered questions + KB-gap clustering e2e (#32, #41)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let idp: TestIdp;
  let ownerToken: string;
  let editorToken: string;
  let viewerToken: string;
  let tenantId: string;
  let projectId: string;
  let widgetKey: string;
  let tenantSchema: string;

  const widgetBase = '/v1/widget/conversations';
  const editorBase = (): string =>
    `/v1/tenants/${tenantId}/projects/${projectId}/unanswered-questions`;
  const authOwner = (): { Authorization: string } => ({
    Authorization: `Bearer ${ownerToken}`,
  });
  const authEditor = (): { Authorization: string } => ({
    Authorization: `Bearer ${editorToken}`,
  });
  const authViewer = (): { Authorization: string } => ({
    Authorization: `Bearer ${viewerToken}`,
  });

  beforeAll(async () => {
    ({ container, pool } = await startPg());
    ({ app, idp } = await buildTestApp(pool));
    ownerToken = await idp.sign({ sub: 'oidc|uq-owner', email: 'owner@uq.eu' });
    editorToken = await idp.sign({
      sub: 'oidc|uq-editor',
      email: 'editor@uq.eu',
    });
    viewerToken = await idp.sign({
      sub: 'oidc|uq-viewer',
      email: 'viewer@uq.eu',
    });

    const t = await request(app.getHttpServer())
      .post('/v1/tenants')
      .set(authOwner())
      .send({ name: 'Acme', slug: 'acme-unanswered' })
      .expect(201);
    tenantId = (t.body as IdBody).id;

    const p = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/projects`)
      .set(authOwner())
      .send({ name: 'Bot', defaultLanguage: 'nl' })
      .expect(201);
    projectId = (p.body as IdBody).id;

    const key = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/api-keys`)
      .set(authOwner())
      .send({ name: 'widget', kind: 'public_widget', projectId })
      .expect(201);
    widgetKey = (key.body as { key: string }).key;

    // Register editor + viewer (self-register on first /tenants call) then
    // attach memberships at the right roles for RBAC assertions.
    for (const tok of [editorToken, viewerToken]) {
      await request(app.getHttpServer())
        .get('/v1/tenants')
        .set({ Authorization: `Bearer ${tok}` })
        .expect(200);
    }
    await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/members`)
      .set(authOwner())
      .send({ email: 'editor@uq.eu', role: 'editor' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/members`)
      .set(authOwner())
      .send({ email: 'viewer@uq.eu', role: 'viewer' })
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

  async function askBot(question: string): Promise<{
    conversationId: string;
    visitorSecret: string;
    botMessageId: string;
  }> {
    const started = await request(app.getHttpServer())
      .post(widgetBase)
      .set('x-bonsai-key', widgetKey)
      .send({ language: 'nl' })
      .expect(201);
    const { id: conversationId, visitorSecret } = started.body as StartBody;

    await request(app.getHttpServer())
      .post(`${widgetBase}/${conversationId}/messages`)
      .set('x-bonsai-key', widgetKey)
      .set('x-bonsai-visitor-secret', visitorSecret)
      .send({ content: question })
      .expect(201);

    const detail = await request(app.getHttpServer())
      .get(`${widgetBase}/${conversationId}`)
      .set('x-bonsai-key', widgetKey)
      .set('x-bonsai-visitor-secret', visitorSecret)
      .expect(200);
    const { messages } = detail.body as ConversationDetail;
    const bot = messages.find((m) => m.role === 'bot');
    if (!bot) throw new Error('expected a refused bot reply');
    return { conversationId, visitorSecret, botMessageId: bot.id };
  }

  it('auto-captures a refused answer as an unanswered question', async () => {
    const q = 'hoe reset ik mijn wachtwoord';
    await askBot(q);

    const rows = await pool.query<{ question: string; reason: string }>(
      `SELECT question, reason FROM "${tenantSchema}".unanswered_questions
       WHERE project_id = $1 AND question = $2`,
      [projectId, q],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].reason).toBe('refused');
  });

  it('an explicit visitor "no" upserts the same row (keyed by message) without double counting', async () => {
    const q = 'wat kost verzending naar belgie';
    const { conversationId, visitorSecret, botMessageId } = await askBot(q);

    // The refusal already created a row; a "no" converges on it.
    await request(app.getHttpServer())
      .post(`${widgetBase}/${conversationId}/messages/${botMessageId}/answered`)
      .set('x-bonsai-key', widgetKey)
      .set('x-bonsai-visitor-secret', visitorSecret)
      .send({ answered: false })
      .expect(201);

    const rows = await pool.query<{ reason: string }>(
      `SELECT reason FROM "${tenantSchema}".unanswered_questions
       WHERE message_id = $1`,
      [botMessageId],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].reason).toBe('visitor_no');

    // The "no" also upserts thumbs-down feedback (reuses message_feedback).
    const fb = await pool.query<{ rating: string }>(
      `SELECT rating FROM "${tenantSchema}".message_feedback WHERE message_id = $1`,
      [botMessageId],
    );
    expect(fb.rows[0].rating).toBe('down');
  });

  it('a visitor "yes" records thumbs-up and does not create an unanswered row for that message', async () => {
    const q = 'iets heel unieks over onze producten';
    const { conversationId, visitorSecret, botMessageId } = await askBot(q);

    // Remove the auto 'refused' row so we can assert "yes" adds nothing.
    await pool.query(
      `DELETE FROM "${tenantSchema}".unanswered_questions WHERE message_id = $1`,
      [botMessageId],
    );

    await request(app.getHttpServer())
      .post(`${widgetBase}/${conversationId}/messages/${botMessageId}/answered`)
      .set('x-bonsai-key', widgetKey)
      .set('x-bonsai-visitor-secret', visitorSecret)
      .send({ answered: true })
      .expect(201);

    const fb = await pool.query<{ rating: string }>(
      `SELECT rating FROM "${tenantSchema}".message_feedback WHERE message_id = $1`,
      [botMessageId],
    );
    expect(fb.rows[0].rating).toBe('up');

    const rows = await pool.query(
      `SELECT 1 FROM "${tenantSchema}".unanswered_questions WHERE message_id = $1`,
      [botMessageId],
    );
    expect(rows.rowCount).toBe(0);
  });

  it('rejects the answered signal with a wrong/missing visitor secret', async () => {
    const { conversationId, botMessageId } = await askBot('random vraag een');
    await request(app.getHttpServer())
      .post(`${widgetBase}/${conversationId}/messages/${botMessageId}/answered`)
      .set('x-bonsai-key', widgetKey)
      .send({ answered: false })
      .expect(401);
    await request(app.getHttpServer())
      .post(`${widgetBase}/${conversationId}/messages/${botMessageId}/answered`)
      .set('x-bonsai-key', widgetKey)
      .set('x-bonsai-visitor-secret', 'wrong-secret-padding-0000000000000000')
      .send({ answered: false })
      .expect(401);
  });

  it('editor list shows open unanswered questions (RBAC: viewer can read)', async () => {
    const res = await request(app.getHttpServer())
      .get(editorBase())
      .set(authViewer())
      .expect(200);
    const rows = res.body as UnansweredRow[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.resolved === false)).toBe(true);
  });

  it('clusters unanswered questions into KB-gap suggestions', async () => {
    // Seed several near-identical phrasings of one gap so they cluster.
    await askBot('hoe kan ik mijn bestelling annuleren');
    await askBot('kan ik mijn bestelling annuleren');
    await askBot('bestelling annuleren hoe doe ik dat');

    const res = await request(app.getHttpServer())
      .get(`${editorBase()}/suggestions`)
      .set(authViewer())
      .query({ threshold: '0.3', minSize: 2 })
      .expect(200);
    const body = res.body as SuggestionsBody;
    expect(body.analyzed).toBeGreaterThan(0);
    expect(body.suggestions.length).toBeGreaterThan(0);
    // Every returned suggestion respects minSize and carries examples.
    for (const s of body.suggestions) {
      expect(s.size).toBeGreaterThanOrEqual(2);
      expect(s.examples.length).toBeGreaterThan(0);
      expect(s.label).toBeTruthy();
    }
  });

  it('editor can mark a question resolved; viewer cannot (RBAC)', async () => {
    const list = await request(app.getHttpServer())
      .get(editorBase())
      .set(authEditor())
      .expect(200);
    const target = (list.body as UnansweredRow[])[0];

    // Viewer is blocked from the mutation.
    await request(app.getHttpServer())
      .patch(`${editorBase()}/${target.id}`)
      .set(authViewer())
      .send({ resolved: true })
      .expect(403);

    // Editor resolves it.
    await request(app.getHttpServer())
      .patch(`${editorBase()}/${target.id}`)
      .set(authEditor())
      .send({ resolved: true })
      .expect(200);

    // It drops out of the default (open) list.
    const open = await request(app.getHttpServer())
      .get(editorBase())
      .set(authEditor())
      .expect(200);
    expect((open.body as UnansweredRow[]).some((r) => r.id === target.id)).toBe(
      false,
    );

    // But shows up under status=resolved.
    const resolved = await request(app.getHttpServer())
      .get(editorBase())
      .set(authEditor())
      .query({ status: 'resolved' })
      .expect(200);
    expect(
      (resolved.body as UnansweredRow[]).some((r) => r.id === target.id),
    ).toBe(true);

    // Audit row written.
    const audit = await pool.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE resource = $1`,
      [`unanswered_question:${target.id}`],
    );
    expect(audit.rows.map((r) => r.action)).toContain(
      'unanswered_question.resolved',
    );
  });

  it('patching an unknown id returns 404', async () => {
    await request(app.getHttpServer())
      .patch(`${editorBase()}/00000000-0000-0000-0000-000000000000`)
      .set(authEditor())
      .send({ resolved: true })
      .expect(404);
  });
});
