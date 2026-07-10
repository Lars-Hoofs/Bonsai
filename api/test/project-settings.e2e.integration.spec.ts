import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPg } from './helpers/pg';
import { buildTestApp } from './helpers/app';
import { TestIdp } from './helpers/oidc';

describe('project settings e2e', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let idp: TestIdp;
  let ownerToken: string;
  let viewerToken: string;
  let tenantId: string;
  let projectId: string;

  const base = (): string =>
    `/v1/tenants/${tenantId}/projects/${projectId}/settings`;
  const authOwner = (): { Authorization: string } => ({
    Authorization: `Bearer ${ownerToken}`,
  });
  const authViewer = (): { Authorization: string } => ({
    Authorization: `Bearer ${viewerToken}`,
  });

  beforeAll(async () => {
    ({ container, pool } = await startPg());
    ({ app, idp } = await buildTestApp(pool));
    ownerToken = await idp.sign({ sub: 'oidc|owner', email: 'owner@acme.eu' });
    viewerToken = await idp.sign({
      sub: 'oidc|viewer',
      email: 'viewer@acme.eu',
    });

    const t = await request(app.getHttpServer())
      .post('/v1/tenants')
      .set(authOwner())
      .send({ name: 'Acme', slug: 'acme-settings' })
      .expect(201);
    tenantId = (t.body as { id: string }).id;

    const p = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/projects`)
      .set(authOwner())
      .send({ name: 'Bot', defaultLanguage: 'nl' })
      .expect(201);
    projectId = (p.body as { id: string }).id;

    // Register the viewer (second user) then attach a viewer membership.
    await request(app.getHttpServer())
      .get('/v1/tenants')
      .set(authViewer())
      .expect(200);
    await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/members`)
      .set(authOwner())
      .send({ email: 'viewer@acme.eu', role: 'viewer' })
      .expect(201);
  }, 120000);

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('GET returns an empty object before any settings are set', async () => {
    const res = await request(app.getHttpServer())
      .get(base())
      .set(authOwner())
      .expect(200);
    expect(res.body).toEqual({});
  });

  it('PATCH sets confidenceThreshold + businessHours, GET reflects them', async () => {
    const patch = {
      confidenceThreshold: 0.42,
      businessHours: {
        timezone: 'Europe/Amsterdam',
        intervals: [{ day: 1, open: '09:00', close: '17:00' }],
      },
    };
    const patched = await request(app.getHttpServer())
      .patch(base())
      .set(authOwner())
      .send(patch)
      .expect(200);
    expect(patched.body).toMatchObject(patch);

    const got = await request(app.getHttpServer())
      .get(base())
      .set(authOwner())
      .expect(200);
    expect(got.body).toMatchObject(patch);
  });

  it('PATCH merges with existing settings rather than replacing them', async () => {
    await request(app.getHttpServer())
      .patch(base())
      .set(authOwner())
      .send({ afterHoursMessage: 'We are closed, leave a message.' })
      .expect(200);

    const got = await request(app.getHttpServer())
      .get(base())
      .set(authOwner())
      .expect(200);
    // Previously-set confidenceThreshold from the prior test must survive.
    expect(got.body).toMatchObject({
      confidenceThreshold: 0.42,
      afterHoursMessage: 'We are closed, leave a message.',
    });
  });

  it('PATCH accepts the boolean feature toggles and retrievalWindow', async () => {
    const patch = {
      selfCheckEnabled: false,
      multiQueryEnabled: true,
      toolCallingEnabled: false,
      followupSuggestionsEnabled: true,
      dedupEnabled: false,
      retrievalWindow: 3,
      verificationMode: 'claim-nli',
    };
    const patched = await request(app.getHttpServer())
      .patch(base())
      .set(authOwner())
      .send(patch)
      .expect(200);
    expect(patched.body).toMatchObject(patch);
  });

  it('rejects an out-of-range confidenceThreshold with 400', async () => {
    await request(app.getHttpServer())
      .patch(base())
      .set(authOwner())
      .send({ confidenceThreshold: 2 })
      .expect(400);
  });

  it('rejects an unknown settings key with 400', async () => {
    await request(app.getHttpServer())
      .patch(base())
      .set(authOwner())
      .send({ someRandomKey: 'nope' })
      .expect(400);
  });

  it('viewer cannot PATCH settings (403)', async () => {
    await request(app.getHttpServer())
      .patch(base())
      .set(authViewer())
      .send({ confidenceThreshold: 0.5 })
      .expect(403);
  });

  it('viewer CAN GET settings', async () => {
    await request(app.getHttpServer())
      .get(base())
      .set(authViewer())
      .expect(200);
  });

  it('404s for a nonexistent project', async () => {
    await request(app.getHttpServer())
      .get(
        `/v1/tenants/${tenantId}/projects/00000000-0000-0000-0000-000000000000/settings`,
      )
      .set(authOwner())
      .expect(404);
  });

  it('writes an audit row on settings update', async () => {
    await request(app.getHttpServer())
      .patch(base())
      .set(authOwner())
      .send({ afterHoursMessage: 'audit check' })
      .expect(200);

    const r = await pool.query(
      `SELECT action, resource FROM audit_log WHERE action = 'project.settings_updated' AND resource = $1`,
      [`project:${projectId}`],
    );
    expect(r.rows.length).toBeGreaterThan(0);
  });
});
