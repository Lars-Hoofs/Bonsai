import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { signPayload } from '../src/webhooks/webhooks.service';
import { startPg } from './helpers/pg';
import { buildTestApp } from './helpers/app';
import { TestIdp } from './helpers/oidc';
import * as safeFetchModule from '../src/common/safe-fetch';

// The fixture receiver below is a loopback (127.0.0.1) HTTP server, which
// safeFetch's SSRF guard correctly rejects in production. Stub it here to
// pass real requests through to the fixture server rather than weakening
// the guard itself.
jest.spyOn(safeFetchModule, 'safeFetch').mockImplementation(
  async (
    rawUrl: string,
    opts?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    },
  ) => {
    const res = await fetch(rawUrl, {
      method: opts?.method,
      headers: opts?.headers,
      body: opts?.body,
    });
    const body = await res.text();
    return { status: res.status, body, finalUrl: rawUrl };
  },
);

interface IdBody {
  id: string;
}
interface StartBody {
  id: string;
  visitorSecret: string;
}

describe('analytics + webhooks e2e', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let idp: TestIdp;
  let token: string;
  let tenantId: string;
  let projectId: string;
  let widgetKey: string;
  let receiver: Server;
  let receiverUrl: string;
  const received: { event: string; signature: string; body: string }[] = [];

  const proj = (): string => `/v1/tenants/${tenantId}/projects/${projectId}`;
  const widgetBase = '/v1/widget/conversations';
  const auth = (): { Authorization: string } => ({
    Authorization: `Bearer ${token}`,
  });

  beforeAll(async () => {
    receiver = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({
          event: String(req.headers['x-bonsai-event']),
          signature: String(req.headers['x-bonsai-signature']),
          body,
        });
        res.writeHead(200).end();
      });
    });
    await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
    receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;

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
    await new Promise<void>((r) => receiver.close(() => r()));
  });

  it('delivers a signed webhook on escalation and reflects it in analytics', async () => {
    const hook = await request(app.getHttpServer())
      .post(`${proj()}/webhooks`)
      .set(auth())
      .send({ url: receiverUrl, events: ['conversation.escalated'] })
      .expect(201);
    const secret = (hook.body as { secret: string }).secret;
    expect(secret).toMatch(/^whsec_/);

    const convo = await request(app.getHttpServer())
      .post(widgetBase)
      .set('x-bonsai-key', widgetKey)
      .send({})
      .expect(201);
    const { id: conversationId, visitorSecret } = convo.body as StartBody;

    // An out-of-KB question produces a refused bot message.
    await request(app.getHttpServer())
      .post(`${widgetBase}/${conversationId}/messages`)
      .set('x-bonsai-key', widgetKey)
      .set('x-bonsai-visitor-secret', visitorSecret)
      .send({ content: 'iets volledig onbekends over astrofysica' })
      .expect(201);

    await request(app.getHttpServer())
      .post(`${widgetBase}/${conversationId}/escalate`)
      .set('x-bonsai-key', widgetKey)
      .set('x-bonsai-visitor-secret', visitorSecret)
      .send({ reason: 'test' })
      .expect(201);

    // Give the best-effort dispatch a moment to reach the receiver.
    await new Promise((r) => setTimeout(r, 300));
    expect(received).toHaveLength(1);
    expect(received[0].event).toBe('conversation.escalated');
    expect(received[0].signature).toBe(signPayload(secret, received[0].body));

    const analytics = await request(app.getHttpServer())
      .get(`${proj()}/analytics`)
      .set(auth())
      .expect(200);
    const a = analytics.body as {
      conversations: number;
      escalations: number;
      refused: number;
    };
    expect(a.conversations).toBe(1);
    expect(a.escalations).toBe(1);
    expect(a.refused).toBeGreaterThanOrEqual(1);

    const unanswered = await request(app.getHttpServer())
      .get(`${proj()}/analytics/unanswered`)
      .set(auth())
      .expect(200);
    expect(unanswered.body as unknown[]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          question: 'iets volledig onbekends over astrofysica',
        }),
      ]),
    );
  });
});
