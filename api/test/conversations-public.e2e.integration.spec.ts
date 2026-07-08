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
});
