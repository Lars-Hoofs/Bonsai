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
interface ReplyBody {
  status: string;
  reply?: {
    content: string;
    refused: boolean;
    escalationSuggested: boolean;
    citations: { documentTitle: string }[];
  };
}
interface ConvoView {
  conversation: { status: string };
  messages: { role: string; content: string }[];
}

describe('conversations + handover e2e', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let idp: TestIdp;
  let token: string;
  let tenantId: string;
  let projectId: string;

  const base = (): string =>
    `/v1/tenants/${tenantId}/projects/${projectId}/conversations`;
  const auth = (): { Authorization: string } => ({
    Authorization: `Bearer ${token}`,
  });

  beforeAll(async () => {
    ({ container, pool } = await startPg());
    ({ app, idp } = await buildTestApp(pool));
    token = await idp.sign({ sub: 'oidc|u1', email: 'u1@acme.eu' });
    const t = await request(app.getHttpServer())
      .post('/v1/tenants')
      .set(auth())
      .send({ name: 'Acme', slug: 'acme' })
      .expect(201);
    tenantId = (t.body as IdBody).id;
    const p = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/projects`)
      .set(auth())
      .send({ name: 'Bot' })
      .expect(201);
    projectId = (p.body as IdBody).id;
    // Seed knowledge so the bot can answer at least one thing.
    await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/projects/${projectId}/knowledge/sources`)
      .set(auth())
      .send({
        type: 'manual',
        name: 'Openingstijden',
        config: {
          title: 'Openingstijden',
          body: 'De openingstijden van onze winkel zijn maandag tot en met vrijdag van negen tot vijf uur.',
        },
      })
      .expect(201);
  }, 120000);

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('runs a full bot -> escalate -> agent -> return-to-bot lifecycle', async () => {
    const convo = await request(app.getHttpServer())
      .post(base())
      .set(auth())
      .send({ language: 'nl' })
      .expect(201);
    const conversationId = (convo.body as IdBody).id;

    // Out-of-KB question -> refusal + escalation suggested.
    const unknown = await request(app.getHttpServer())
      .post(`${base()}/${conversationId}/messages`)
      .set(auth())
      .send({ content: 'hoe werkt kwantumverstrengeling in de ruimtevaart' })
      .expect(201);
    const unknownBody = unknown.body as ReplyBody;
    expect(unknownBody.status).toBe('bot');
    expect(unknownBody.reply?.refused).toBe(true);
    expect(unknownBody.reply?.escalationSuggested).toBe(true);

    // Escalate to a human.
    await request(app.getHttpServer())
      .post(`${base()}/${conversationId}/escalate`)
      .set(auth())
      .send({ reason: 'frustration' })
      .expect(201);

    // Conversation now shows up in the agent inbox.
    const inbox = await request(app.getHttpServer())
      .get(`${base()}?status=handover`)
      .set(auth())
      .expect(200);
    expect((inbox.body as IdBody[]).map((c) => c.id)).toContain(conversationId);

    // Agent replies.
    await request(app.getHttpServer())
      .post(`${base()}/${conversationId}/agent-messages`)
      .set(auth())
      .send({ content: 'Hoi, ik help je verder!' })
      .expect(201);

    // A visitor message during handover is stored but not auto-answered.
    const during = await request(app.getHttpServer())
      .post(`${base()}/${conversationId}/messages`)
      .set(auth())
      .send({ content: 'dank je' })
      .expect(201);
    expect((during.body as ReplyBody).status).toBe('handover');
    expect((during.body as ReplyBody).reply).toBeUndefined();

    // Return to bot.
    await request(app.getHttpServer())
      .post(`${base()}/${conversationId}/return-to-bot`)
      .set(auth())
      .expect(201);

    const view = await request(app.getHttpServer())
      .get(`${base()}/${conversationId}`)
      .set(auth())
      .expect(200);
    const v = view.body as ConvoView;
    expect(v.conversation.status).toBe('bot');
    expect(v.messages.some((m) => m.role === 'agent')).toBe(true);
    expect(v.messages.some((m) => m.role === 'system')).toBe(true);
  });
});
