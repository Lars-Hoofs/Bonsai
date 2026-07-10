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

describe('public widget conversations e2e (visitor auth + isolation)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let idp: TestIdp;
  let token: string;
  let tenantId: string;
  let projectId: string;
  let widgetKey: string;
  let tenantSchema: string;

  const widgetBase = '/v1/widget/conversations';
  const auth = (): { Authorization: string } => ({
    Authorization: `Bearer ${token}`,
  });

  beforeAll(async () => {
    ({ container, pool } = await startPg());
    ({ app, idp } = await buildTestApp(pool));
    token = await idp.sign({ sub: 'oidc|u2', email: 'u2@acme.eu' });
    const t = await request(app.getHttpServer())
      .post('/v1/tenants')
      .set(auth())
      .send({ name: 'Acme2', slug: 'acme2' })
      .expect(201);
    tenantId = (t.body as IdBody).id;
    const p = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/projects`)
      .set(auth())
      .send({ name: 'Bot' })
      .expect(201);
    projectId = (p.body as IdBody).id;

    const key = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/api-keys`)
      .set(auth())
      .send({ name: 'widget', kind: 'public_widget', projectId })
      .expect(201);
    widgetKey = (key.body as { key: string }).key;

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

  it('rejects an invalid/missing widget key at the guard, before conversation logic runs', async () => {
    await request(app.getHttpServer())
      .post(widgetBase)
      .send({ language: 'nl' })
      .expect(401);

    await request(app.getHttpServer())
      .post(widgetBase)
      .set('x-bonsai-key', 'bsk_totally_bogus')
      .send({ language: 'nl' })
      .expect(401);
  });

  it('start requires a valid key and returns a visitorSecret only on creation', async () => {
    const res = await request(app.getHttpServer())
      .post(widgetBase)
      .set('x-bonsai-key', widgetKey)
      .send({ language: 'nl' })
      .expect(201);
    const body = res.body as StartBody;
    expect(body.id).toBeDefined();
    expect(body.visitorSecret).toBeDefined();
    expect(typeof body.visitorSecret).toBe('string');
    expect(body.visitorSecret.length).toBeGreaterThan(20);
  });

  it('rejects get/postMessage/escalate without a visitor secret, or with the wrong one, and never returns conversation data', async () => {
    const started = await request(app.getHttpServer())
      .post(widgetBase)
      .set('x-bonsai-key', widgetKey)
      .send({ language: 'nl' })
      .expect(201);
    const { id: conversationId } = started.body as StartBody;
    const wrongSecret = 'not-the-real-secret-0000000000000000000000';

    // GET without secret.
    const noSecretGet = await request(app.getHttpServer())
      .get(`${widgetBase}/${conversationId}`)
      .set('x-bonsai-key', widgetKey)
      .expect(401);
    expect(noSecretGet.body).not.toHaveProperty('conversation');

    // GET with wrong secret.
    const wrongSecretGet = await request(app.getHttpServer())
      .get(`${widgetBase}/${conversationId}`)
      .set('x-bonsai-key', widgetKey)
      .set('x-bonsai-visitor-secret', wrongSecret)
      .expect(401);
    expect(wrongSecretGet.body).not.toHaveProperty('conversation');

    // postMessage without secret.
    await request(app.getHttpServer())
      .post(`${widgetBase}/${conversationId}/messages`)
      .set('x-bonsai-key', widgetKey)
      .send({ content: 'hallo' })
      .expect(401);

    // postMessage with wrong secret.
    await request(app.getHttpServer())
      .post(`${widgetBase}/${conversationId}/messages`)
      .set('x-bonsai-key', widgetKey)
      .set('x-bonsai-visitor-secret', wrongSecret)
      .send({ content: 'hallo' })
      .expect(401);

    // escalate without secret.
    await request(app.getHttpServer())
      .post(`${widgetBase}/${conversationId}/escalate`)
      .set('x-bonsai-key', widgetKey)
      .send({ reason: 'x' })
      .expect(401);

    // escalate with wrong secret.
    await request(app.getHttpServer())
      .post(`${widgetBase}/${conversationId}/escalate`)
      .set('x-bonsai-key', widgetKey)
      .set('x-bonsai-visitor-secret', wrongSecret)
      .send({ reason: 'x' })
      .expect(401);
  });

  it('cross-conversation isolation: visitor A cannot use secretA to read/post into visitor B conversation, and vice versa', async () => {
    const a = await request(app.getHttpServer())
      .post(widgetBase)
      .set('x-bonsai-key', widgetKey)
      .send({ visitorId: 'visitor-a', language: 'nl' })
      .expect(201);
    const { id: conversationA, visitorSecret: secretA } = a.body as StartBody;

    const b = await request(app.getHttpServer())
      .post(widgetBase)
      .set('x-bonsai-key', widgetKey)
      .send({ visitorId: 'visitor-b', language: 'nl' })
      .expect(201);
    const { id: conversationB, visitorSecret: secretB } = b.body as StartBody;

    expect(conversationA).not.toBe(conversationB);
    expect(secretA).not.toBe(secretB);

    // A's secret does not open B's conversation.
    await request(app.getHttpServer())
      .get(`${widgetBase}/${conversationB}`)
      .set('x-bonsai-key', widgetKey)
      .set('x-bonsai-visitor-secret', secretA)
      .expect(401);
    await request(app.getHttpServer())
      .post(`${widgetBase}/${conversationB}/messages`)
      .set('x-bonsai-key', widgetKey)
      .set('x-bonsai-visitor-secret', secretA)
      .send({ content: 'sneaky' })
      .expect(401);

    // B's secret does not open A's conversation.
    await request(app.getHttpServer())
      .get(`${widgetBase}/${conversationA}`)
      .set('x-bonsai-key', widgetKey)
      .set('x-bonsai-visitor-secret', secretB)
      .expect(401);

    // Each visitor's own secret works on their own conversation.
    await request(app.getHttpServer())
      .get(`${widgetBase}/${conversationA}`)
      .set('x-bonsai-key', widgetKey)
      .set('x-bonsai-visitor-secret', secretA)
      .expect(200);
    await request(app.getHttpServer())
      .get(`${widgetBase}/${conversationB}`)
      .set('x-bonsai-key', widgetKey)
      .set('x-bonsai-visitor-secret', secretB)
      .expect(200);
  });

  it('returns 404 (not 401) for a conversationId that does not exist at all', async () => {
    await request(app.getHttpServer())
      .get(`${widgetBase}/00000000-0000-0000-0000-000000000000`)
      .set('x-bonsai-key', widgetKey)
      .set('x-bonsai-visitor-secret', 'whatever-secret-value-padding-out')
      .expect(404);
  });

  it('rate-limits unbounded `start` calls (20/min/project+IP) with 429', async () => {
    // Uses its own project + widget key so its bucket (keyed by
    // project+IP) is independent of the `start` calls other tests in this
    // file already made against the shared `widgetKey`/`projectId`.
    const p = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/projects`)
      .set(auth())
      .send({ name: 'RateLimitTarget' })
      .expect(201);
    const rlProjectId = (p.body as IdBody).id;
    const key = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/api-keys`)
      .set(auth())
      .send({
        name: 'widget-rl',
        kind: 'public_widget',
        projectId: rlProjectId,
      })
      .expect(201);
    const rlWidgetKey = (key.body as { key: string }).key;

    const start = (): request.Test =>
      request(app.getHttpServer())
        .post(widgetBase)
        .set('x-bonsai-key', rlWidgetKey)
        .send({ language: 'nl' });

    for (let i = 0; i < 20; i++) {
      await start().expect(201);
    }
    await start().expect(429);
  });

  describe('CSAT + message feedback (#23)', () => {
    interface ConversationDetail {
      conversation: { id: string };
      messages: { id: string; role: string }[];
    }

    async function startConversationWithBotReply(): Promise<{
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
        .send({ content: 'hallo, wat zijn jullie openingstijden?' })
        .expect(201);

      const detail = await request(app.getHttpServer())
        .get(`${widgetBase}/${conversationId}`)
        .set('x-bonsai-key', widgetKey)
        .set('x-bonsai-visitor-secret', visitorSecret)
        .expect(200);
      const { messages } = detail.body as ConversationDetail;
      const botMessage = messages.find((m) => m.role === 'bot');
      if (!botMessage) throw new Error('expected a bot reply message');
      return { conversationId, visitorSecret, botMessageId: botMessage.id };
    }

    it('accepts a CSAT score + comment from the owning visitor and stores it (idempotent overwrite)', async () => {
      const { conversationId, visitorSecret } =
        await startConversationWithBotReply();

      await request(app.getHttpServer())
        .post(`${widgetBase}/${conversationId}/csat`)
        .set('x-bonsai-key', widgetKey)
        .set('x-bonsai-visitor-secret', visitorSecret)
        .send({ score: 5, comment: 'Great bot!' })
        .expect(201);

      // Overwrite (idempotent) — same conversation, new score/comment.
      await request(app.getHttpServer())
        .post(`${widgetBase}/${conversationId}/csat`)
        .set('x-bonsai-key', widgetKey)
        .set('x-bonsai-visitor-secret', visitorSecret)
        .send({ score: 2, comment: 'Actually, not great' })
        .expect(201);

      const row = await pool.query<{
        csat_score: number | null;
        csat_comment: string | null;
      }>(
        `SELECT csat_score, csat_comment FROM "${tenantSchema}".conversations WHERE id = $1`,
        [conversationId],
      );
      expect(row.rows[0].csat_score).toBe(2);
      expect(row.rows[0].csat_comment).toBe('Actually, not great');
    });

    it('rejects CSAT with wrong/missing visitor secret (403/401) and never mutates', async () => {
      const { conversationId } = await startConversationWithBotReply();

      await request(app.getHttpServer())
        .post(`${widgetBase}/${conversationId}/csat`)
        .set('x-bonsai-key', widgetKey)
        .send({ score: 4 })
        .expect(401);

      await request(app.getHttpServer())
        .post(`${widgetBase}/${conversationId}/csat`)
        .set('x-bonsai-key', widgetKey)
        .set('x-bonsai-visitor-secret', 'wrong-secret-padding-0000000000000000')
        .send({ score: 4 })
        .expect(401);

      const row = await pool.query<{ csat_score: number | null }>(
        `SELECT csat_score FROM "${tenantSchema}".conversations WHERE id = $1`,
        [conversationId],
      );
      expect(row.rows[0].csat_score).toBeNull();
    });

    it('rejects out-of-range CSAT scores', async () => {
      const { conversationId, visitorSecret } =
        await startConversationWithBotReply();

      await request(app.getHttpServer())
        .post(`${widgetBase}/${conversationId}/csat`)
        .set('x-bonsai-key', widgetKey)
        .set('x-bonsai-visitor-secret', visitorSecret)
        .send({ score: 0 })
        .expect(400);

      await request(app.getHttpServer())
        .post(`${widgetBase}/${conversationId}/csat`)
        .set('x-bonsai-key', widgetKey)
        .set('x-bonsai-visitor-secret', visitorSecret)
        .send({ score: 6 })
        .expect(400);
    });

    it('rejects CSAT from a different conversation/visitor secret pairing (cross-conversation mismatch)', async () => {
      const a = await startConversationWithBotReply();
      const b = await startConversationWithBotReply();

      await request(app.getHttpServer())
        .post(`${widgetBase}/${a.conversationId}/csat`)
        .set('x-bonsai-key', widgetKey)
        .set('x-bonsai-visitor-secret', b.visitorSecret)
        .send({ score: 5 })
        .expect(401);
    });

    it('thumbs-up a bot message with the owning visitor secret and stores the rating', async () => {
      const { conversationId, visitorSecret, botMessageId } =
        await startConversationWithBotReply();

      await request(app.getHttpServer())
        .post(
          `${widgetBase}/${conversationId}/messages/${botMessageId}/feedback`,
        )
        .set('x-bonsai-key', widgetKey)
        .set('x-bonsai-visitor-secret', visitorSecret)
        .send({ rating: 'up' })
        .expect(201);

      const row = await pool.query<{ rating: string }>(
        `SELECT rating FROM "${tenantSchema}".message_feedback WHERE message_id = $1`,
        [botMessageId],
      );
      expect(row.rows[0].rating).toBe('up');

      // Upsert: visitor changes their mind.
      await request(app.getHttpServer())
        .post(
          `${widgetBase}/${conversationId}/messages/${botMessageId}/feedback`,
        )
        .set('x-bonsai-key', widgetKey)
        .set('x-bonsai-visitor-secret', visitorSecret)
        .send({ rating: 'down' })
        .expect(201);

      const row2 = await pool.query<{ rating: string }>(
        `SELECT rating FROM "${tenantSchema}".message_feedback WHERE message_id = $1`,
        [botMessageId],
      );
      expect(row2.rows[0].rating).toBe('down');
    });

    it('rejects message feedback with wrong/missing visitor secret and never mutates', async () => {
      const { conversationId, botMessageId } =
        await startConversationWithBotReply();

      await request(app.getHttpServer())
        .post(
          `${widgetBase}/${conversationId}/messages/${botMessageId}/feedback`,
        )
        .set('x-bonsai-key', widgetKey)
        .send({ rating: 'up' })
        .expect(401);

      await request(app.getHttpServer())
        .post(
          `${widgetBase}/${conversationId}/messages/${botMessageId}/feedback`,
        )
        .set('x-bonsai-key', widgetKey)
        .set('x-bonsai-visitor-secret', 'wrong-secret-padding-0000000000000000')
        .send({ rating: 'up' })
        .expect(401);

      const row = await pool.query(
        `SELECT rating FROM "${tenantSchema}".message_feedback WHERE message_id = $1`,
        [botMessageId],
      );
      expect(row.rowCount).toBe(0);
    });

    it('rejects feedback on a message that does not belong to the conversation', async () => {
      const a = await startConversationWithBotReply();
      const b = await startConversationWithBotReply();

      // b's message id, but a's conversation id + secret.
      await request(app.getHttpServer())
        .post(
          `${widgetBase}/${a.conversationId}/messages/${b.botMessageId}/feedback`,
        )
        .set('x-bonsai-key', widgetKey)
        .set('x-bonsai-visitor-secret', a.visitorSecret)
        .send({ rating: 'up' })
        .expect(404);

      const row = await pool.query(
        `SELECT rating FROM "${tenantSchema}".message_feedback WHERE message_id = $1`,
        [b.botMessageId],
      );
      expect(row.rowCount).toBe(0);
    });

    it('rejects an invalid rating value', async () => {
      const { conversationId, visitorSecret, botMessageId } =
        await startConversationWithBotReply();

      await request(app.getHttpServer())
        .post(
          `${widgetBase}/${conversationId}/messages/${botMessageId}/feedback`,
        )
        .set('x-bonsai-key', widgetKey)
        .set('x-bonsai-visitor-secret', visitorSecret)
        .send({ rating: 'sideways' })
        .expect(400);
    });
  });

  describe('resume across reloads (id + secret) (#13)', () => {
    interface ResumeBody {
      conversation: { id: string; projectId: string; status: string };
      messages: {
        id: string;
        role: string;
        content: string;
        citations: {
          documentId: string;
          documentTitle: string;
          originUrl: string | null;
        }[];
      }[];
    }

    it('a returning visitor resumes with id + secret and gets the full history with citations', async () => {
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
        .send({ content: 'hallo, wat zijn jullie openingstijden?' })
        .expect(201);

      // Simulate a page reload: the widget only kept id + secret and POSTs
      // the secret in the body to rehydrate.
      const resumed = await request(app.getHttpServer())
        .post(`${widgetBase}/${conversationId}/resume`)
        .set('x-bonsai-key', widgetKey)
        .send({ visitorSecret })
        .expect(201);
      const body = resumed.body as ResumeBody;
      expect(body.conversation.id).toBe(conversationId);
      expect(body.messages.length).toBeGreaterThanOrEqual(2);
      expect(body.messages[0].role).toBe('visitor');
      // Every message carries a citations array (empty for non-bot messages).
      for (const m of body.messages) {
        expect(Array.isArray(m.citations)).toBe(true);
      }
    });

    it('rejects resume without a secret, or with the wrong secret, and never returns conversation data', async () => {
      const started = await request(app.getHttpServer())
        .post(widgetBase)
        .set('x-bonsai-key', widgetKey)
        .send({ language: 'nl' })
        .expect(201);
      const { id: conversationId } = started.body as StartBody;

      // Missing secret -> DTO validation rejects (400).
      const noSecret = await request(app.getHttpServer())
        .post(`${widgetBase}/${conversationId}/resume`)
        .set('x-bonsai-key', widgetKey)
        .send({})
        .expect(400);
      expect(noSecret.body).not.toHaveProperty('conversation');

      // Wrong secret -> 401, no data.
      const wrongSecret = await request(app.getHttpServer())
        .post(`${widgetBase}/${conversationId}/resume`)
        .set('x-bonsai-key', widgetKey)
        .send({ visitorSecret: 'not-the-real-secret-0000000000000000000000' })
        .expect(401);
      expect(wrongSecret.body).not.toHaveProperty('conversation');
    });

    it('returns 404 for a conversationId that does not exist at all', async () => {
      await request(app.getHttpServer())
        .post(`${widgetBase}/00000000-0000-0000-0000-000000000000/resume`)
        .set('x-bonsai-key', widgetKey)
        .send({ visitorSecret: 'whatever-secret-value-padding-out-00000' })
        .expect(404);
    });

    it('cross-conversation isolation: secret A cannot resume conversation B', async () => {
      const a = await request(app.getHttpServer())
        .post(widgetBase)
        .set('x-bonsai-key', widgetKey)
        .send({ visitorId: 'resume-a', language: 'nl' })
        .expect(201);
      const { visitorSecret: secretA } = a.body as StartBody;

      const b = await request(app.getHttpServer())
        .post(widgetBase)
        .set('x-bonsai-key', widgetKey)
        .send({ visitorId: 'resume-b', language: 'nl' })
        .expect(201);
      const { id: conversationB } = b.body as StartBody;

      await request(app.getHttpServer())
        .post(`${widgetBase}/${conversationB}/resume`)
        .set('x-bonsai-key', widgetKey)
        .send({ visitorSecret: secretA })
        .expect(401);
    });
  });
});
