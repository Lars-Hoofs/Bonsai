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

describe('chat websocket streaming e2e', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let idp: TestIdp;
  let token: string;
  let url: string;
  let tenantId: string;
  let projectId: string;

  const proj = (): string => `/v1/tenants/${tenantId}/projects/${projectId}`;
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
  }, 120000);

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('broadcasts visitor and bot messages to a joined client', async () => {
    const convo = await request(app.getHttpServer())
      .post(`${proj()}/conversations`)
      .set(auth())
      .send({})
      .expect(201);
    const conversationId = (convo.body as IdBody).id;

    const client: Socket = io(url, {
      transports: ['websocket'],
      forceNew: true,
    });
    const received: { role: string; content: string }[] = [];
    client.on('message', (m: { role: string; content: string }) =>
      received.push(m),
    );

    await new Promise<void>((resolve, reject) => {
      client.on('connect_error', reject);
      client.emit('join', { conversationId }, () => resolve());
    });

    await request(app.getHttpServer())
      .post(`${proj()}/conversations/${conversationId}/messages`)
      .set(auth())
      .send({ content: 'hallo daar' })
      .expect(201);

    // Allow the broadcast to arrive.
    await new Promise((r) => setTimeout(r, 500));
    client.close();

    expect(received.some((m) => m.role === 'visitor')).toBe(true);
    expect(received.some((m) => m.role === 'bot')).toBe(true);
  });
});
