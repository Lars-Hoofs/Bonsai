import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ApiKeysService } from '../src/apikeys/apikeys.service';
import { startPg } from './helpers/pg';
import { buildTestApp } from './helpers/app';

describe('api keys e2e', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let token: string;
  let tenantId: string;

  beforeAll(async () => {
    ({ container, pool } = await startPg());
    const built = await buildTestApp(pool);
    app = built.app;
    token = await built.idp.sign({ sub: 'oidc|u1', email: 'u1@acme.eu' });
    const t = await request(app.getHttpServer())
      .post('/v1/tenants')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Test Tenant', slug: 't11' })
      .expect(201);
    tenantId = (t.body as { id: string }).id;
  });
  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('issues a key (secret shown once), verifies it, then revoke kills it', async () => {
    const res = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/api-keys`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'ci key', kind: 'secret' })
      .expect(201);
    const { key, id: keyId } = res.body as { key: string; id: string };
    expect(key).toMatch(/^bsk_/);

    const svc = app.get(ApiKeysService);
    const verified = await svc.verify(key);
    expect(verified).toMatchObject({ tenantId, kind: 'secret' });

    const list = await request(app.getHttpServer())
      .get(`/v1/tenants/${tenantId}/api-keys`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const listed = (list.body as Record<string, unknown>[])[0];
    expect(listed).not.toHaveProperty('keyHash');
    expect(listed).not.toHaveProperty('key');

    await request(app.getHttpServer())
      .delete(`/v1/tenants/${tenantId}/api-keys/${keyId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(await svc.verify(key)).toBeNull();
  });
});
