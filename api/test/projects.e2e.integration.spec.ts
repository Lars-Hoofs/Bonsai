import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPg } from './helpers/pg';
import { buildTestApp } from './helpers/app';
import { TestIdp } from './helpers/oidc';

describe('projects e2e', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let idp: TestIdp;
  let token: string;
  let tenantId: string;
  let otherTenantId: string;

  beforeAll(async () => {
    ({ container, pool } = await startPg());
    ({ app, idp } = await buildTestApp(pool));
    token = await idp.sign({ sub: 'oidc|u1', email: 'u1@acme.eu' });
    const t1 = await request(app.getHttpServer())
      .post('/v1/tenants')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'T1', slug: 't1x' })
      .expect(201);
    tenantId = (t1.body as { id: string }).id;
    const otherToken = await idp.sign({ sub: 'oidc|u2', email: 'u2@other.eu' });
    const t2 = await request(app.getHttpServer())
      .post('/v1/tenants')
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ name: 'T2', slug: 't2x' })
      .expect(201);
    otherTenantId = (t2.body as { id: string }).id;
  });
  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('full CRUD lifecycle', async () => {
    const created = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/projects`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Webshop bot' })
      .expect(201);
    expect(created.body).toMatchObject({
      name: 'Webshop bot',
      defaultLanguage: 'nl',
      status: 'active',
    });
    const pid = (created.body as { id: string }).id;

    const list = await request(app.getHttpServer())
      .get(`/v1/tenants/${tenantId}/projects`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(list.body).toHaveLength(1);

    await request(app.getHttpServer())
      .patch(`/v1/tenants/${tenantId}/projects/${pid}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Support bot' })
      .expect(200);

    const got = await request(app.getHttpServer())
      .get(`/v1/tenants/${tenantId}/projects/${pid}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect((got.body as { name: string }).name).toBe('Support bot');

    await request(app.getHttpServer())
      .delete(`/v1/tenants/${tenantId}/projects/${pid}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const after = await request(app.getHttpServer())
      .get(`/v1/tenants/${tenantId}/projects`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(after.body).toHaveLength(0);
  });

  it('cannot read another tenant’s projects (403, not just empty)', async () => {
    await request(app.getHttpServer())
      .get(`/v1/tenants/${otherTenantId}/projects`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('404s on a project id from another tenant schema', async () => {
    const created = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/projects`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Mine' })
      .expect(201);
    const otherToken = await idp.sign({ sub: 'oidc|u2', email: 'u2@other.eu' });
    const projectId = (created.body as { id: string }).id;
    await request(app.getHttpServer())
      .get(`/v1/tenants/${otherTenantId}/projects/${projectId}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404);
  });
});
