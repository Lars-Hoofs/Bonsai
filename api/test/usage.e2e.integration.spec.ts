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

describe('usage quota (cost cap) e2e', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let idp: TestIdp;
  let token: string;
  let tenantId: string;
  let projectId: string;

  const proj = (): string => `/v1/tenants/${tenantId}/projects/${projectId}`;
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
    // Tighten the monthly answer quota to 2 for this tenant.
    await pool.query(
      `UPDATE tenants SET monthly_answer_quota = 2 WHERE id = $1`,
      [tenantId],
    );
  }, 120000);

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('meters answers and blocks with 402 once the quota is reached', async () => {
    const ask = (): request.Test =>
      request(app.getHttpServer())
        .post(`${proj()}/answer`)
        .set(auth())
        .send({ question: 'wat dan ook' });

    await ask().expect(201); // used 1/2
    await ask().expect(201); // used 2/2
    await ask().expect(402); // over quota

    const usage = await request(app.getHttpServer())
      .get(`/v1/tenants/${tenantId}/usage`)
      .set(auth())
      .expect(200);
    const u = usage.body as { used: number; quota: number; remaining: number };
    expect(u.quota).toBe(2);
    expect(u.used).toBe(2);
    expect(u.remaining).toBe(0);
  });
});
