import { INestApplication } from '@nestjs/common';
import { AddressInfo } from 'node:net';
import { Server as HttpServer } from 'node:http';
import request from 'supertest';
import { io, Socket } from 'socket.io-client';
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

describe('chat websocket streaming e2e', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let idp: TestIdp;
  let token: string;
  let url: string;
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
    await app.listen(0);
    const port = (app.getHttpServer() as HttpServer).address() as AddressInfo;
    url = `http://127.0.0.1:${port.port}/chat`;

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
  });

  it('broadcasts visitor and bot messages to a joined client with a valid key + secret', async () => {
    const convo = await request(app.getHttpServer())
      .post(widgetBase)
      .set('x-bonsai-key', widgetKey)
      .send({})
      .expect(201);
    const { id: conversationId, visitorSecret } = convo.body as StartBody;

    const client: Socket = io(url, {
      transports: ['websocket'],
      forceNew: true,
    });
    const received: { role: string; content: string }[] = [];
    client.on('message', (m: { role: string; content: string }) =>
      received.push(m),
    );

    const joinAck = await new Promise<{ ok?: true; error?: string }>(
      (resolve, reject) => {
        client.on('connect_error', reject);
        client.emit(
          'join',
          { conversationId, visitorSecret, key: widgetKey },
          (ack: { ok?: true; error?: string }) => resolve(ack),
        );
      },
    );
    expect(joinAck.ok).toBe(true);

    await request(app.getHttpServer())
      .post(`${widgetBase}/${conversationId}/messages`)
      .set('x-bonsai-key', widgetKey)
      .set('x-bonsai-visitor-secret', visitorSecret)
      .send({ content: 'hallo daar' })
      .expect(201);

    // Allow the broadcast to arrive.
    await new Promise((r) => setTimeout(r, 500));
    client.close();

    expect(received.some((m) => m.role === 'visitor')).toBe(true);
    expect(received.some((m) => m.role === 'bot')).toBe(true);
  });

  it('rejects join with a wrong/missing visitor secret and does not deliver broadcasts', async () => {
    const convo = await request(app.getHttpServer())
      .post(widgetBase)
      .set('x-bonsai-key', widgetKey)
      .send({})
      .expect(201);
    const { id: conversationId } = convo.body as StartBody;

    const client: Socket = io(url, {
      transports: ['websocket'],
      forceNew: true,
    });
    const received: { role: string; content: string }[] = [];
    client.on('message', (m: { role: string; content: string }) =>
      received.push(m),
    );

    const joinAck = await new Promise<{ ok?: true; error?: string }>(
      (resolve, reject) => {
        client.on('connect_error', reject);
        client.emit(
          'join',
          {
            conversationId,
            visitorSecret: 'totally-wrong-secret',
            key: widgetKey,
          },
          (ack: { ok?: true; error?: string }) => resolve(ack),
        );
      },
    );
    expect(joinAck.error).toBe('unauthorized');

    // A message should NOT arrive at this client, since join must have
    // failed to actually join the room.
    await new Promise((r) => setTimeout(r, 300));
    client.close();
    expect(received.length).toBe(0);
  });
});
