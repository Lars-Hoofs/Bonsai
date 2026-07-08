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

describe('public widget delivery e2e', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let idp: TestIdp;
  let token: string;
  let tenantId: string;
  let projectId: string;
  let widgetKey: string;
  const ORIGIN = 'https://klant.example';

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

    // Publish a theme so there is something to deliver.
    await request(app.getHttpServer())
      .post(
        `/v1/tenants/${tenantId}/projects/${projectId}/widget/theme/publish`,
      )
      .set(auth())
      .expect(201);

    // Issue an origin-restricted public widget key for this project.
    const key = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/api-keys`)
      .set(auth())
      .send({
        name: 'widget',
        kind: 'public_widget',
        projectId,
        allowedOrigins: [ORIGIN],
      })
      .expect(201);
    widgetKey = (key.body as { key: string }).key;
  }, 120000);

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('serves the published theme for a valid key from an allowed origin', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/widget/config')
      .set('x-bonsai-key', widgetKey)
      .set('Origin', ORIGIN)
      .expect(200);
    const body = res.body as {
      version: number;
      theme: { window?: { accent?: string } };
    };
    expect(body.version).toBe(1);
    expect(body.theme.window?.accent).toBe('#7C3AED');
  });

  it('rejects a request from a disallowed origin', async () => {
    await request(app.getHttpServer())
      .get('/v1/widget/config')
      .set('x-bonsai-key', widgetKey)
      .set('Origin', 'https://evil.example')
      .expect(401);
  });

  it('rejects an unknown key', async () => {
    await request(app.getHttpServer())
      .get('/v1/widget/config')
      .set('x-bonsai-key', 'bsk_nonsense')
      .set('Origin', ORIGIN)
      .expect(401);
  });
});
