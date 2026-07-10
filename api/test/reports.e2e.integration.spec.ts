import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPg } from './helpers/pg';
import { buildTestApp } from './helpers/app';
import { TestIdp } from './helpers/oidc';

interface ScheduleBody {
  id: string;
  projectId: string;
  cadence: string;
  format: string;
  deliverEmail: boolean;
  deliverStorage: boolean;
  recipients: string[];
  enabled: boolean;
  nextRunAt: string;
}

describe('reports e2e', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let idp: TestIdp;
  let ownerToken: string;
  let viewerToken: string;
  let tenantId: string;
  let projectId: string;

  const base = (): string =>
    `/v1/tenants/${tenantId}/projects/${projectId}/reports`;
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
      .send({ name: 'Acme', slug: 'acme-reports' })
      .expect(201);
    tenantId = (t.body as { id: string }).id;

    const p = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/projects`)
      .set(authOwner())
      .send({ name: 'Bot', defaultLanguage: 'nl' })
      .expect(201);
    projectId = (p.body as { id: string }).id;

    // Register the viewer (second user) then attach a viewer membership so we
    // can assert editor-gated RBAC on the endpoints.
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

  it('exports a JSON report with a download header', async () => {
    const res = await request(app.getHttpServer())
      .get(`${base()}/export?format=json`)
      .set(authOwner())
      .expect(200);

    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['content-disposition']).toMatch(
      /attachment; filename="report_.*\.json"/,
    );
    const body = res.body as {
      projectId: string;
      analytics: { conversations: number };
      csat: unknown;
      usage: unknown;
    };
    expect(body.projectId).toBe(projectId);
    expect(body.analytics.conversations).toBe(0);
    expect(body.csat).toBeDefined();
    expect(body.usage).toBeDefined();
  });

  it('exports a CSV report with the correct content type and header', async () => {
    const res = await request(app.getHttpServer())
      .get(`${base()}/export?format=csv`)
      .set(authOwner())
      .expect(200);

    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toMatch(
      /attachment; filename="report_.*\.csv"/,
    );
    const text = res.text;
    expect(text.split('\r\n')[0]).toBe('section,metric,value');
    expect(text).toContain('analytics,conversations,0');
  });

  it('defaults to JSON when no format is given', async () => {
    const res = await request(app.getHttpServer())
      .get(`${base()}/export`)
      .set(authOwner())
      .expect(200);
    expect(res.headers['content-type']).toContain('application/json');
  });

  it('creates, lists, updates and deletes a schedule', async () => {
    const created = await request(app.getHttpServer())
      .post(`${base()}/schedules`)
      .set(authOwner())
      .send({
        cadence: 'weekly',
        format: 'csv',
        deliverEmail: true,
        recipients: ['ops@acme.eu'],
      })
      .expect(201);
    const schedule = created.body as ScheduleBody;
    expect(schedule.cadence).toBe('weekly');
    expect(schedule.format).toBe('csv');
    expect(schedule.deliverEmail).toBe(true);
    expect(schedule.recipients).toEqual(['ops@acme.eu']);
    expect(schedule.enabled).toBe(true);

    const list = await request(app.getHttpServer())
      .get(`${base()}/schedules`)
      .set(authOwner())
      .expect(200);
    expect(
      (list.body as ScheduleBody[]).some((s) => s.id === schedule.id),
    ).toBe(true);

    const updated = await request(app.getHttpServer())
      .patch(`${base()}/schedules/${schedule.id}`)
      .set(authOwner())
      .send({ cadence: 'monthly', enabled: false })
      .expect(200);
    expect((updated.body as ScheduleBody).cadence).toBe('monthly');
    expect((updated.body as ScheduleBody).enabled).toBe(false);

    await request(app.getHttpServer())
      .delete(`${base()}/schedules/${schedule.id}`)
      .set(authOwner())
      .expect(200);

    const after = await request(app.getHttpServer())
      .get(`${base()}/schedules`)
      .set(authOwner())
      .expect(200);
    expect(
      (after.body as ScheduleBody[]).some((s) => s.id === schedule.id),
    ).toBe(false);
  });

  it('rejects a schedule with no delivery channel', async () => {
    await request(app.getHttpServer())
      .post(`${base()}/schedules`)
      .set(authOwner())
      .send({ cadence: 'weekly', format: 'json' })
      .expect(400);
  });

  it('rejects email delivery without recipients', async () => {
    await request(app.getHttpServer())
      .post(`${base()}/schedules`)
      .set(authOwner())
      .send({ cadence: 'weekly', format: 'json', deliverEmail: true })
      .expect(400);
  });

  it('rejects an invalid cadence', async () => {
    await request(app.getHttpServer())
      .post(`${base()}/schedules`)
      .set(authOwner())
      .send({ cadence: 'hourly', format: 'json', deliverStorage: true })
      .expect(400);
  });

  it('returns 404 when updating/deleting a non-existent schedule', async () => {
    const missing = '00000000-0000-0000-0000-000000000000';
    await request(app.getHttpServer())
      .patch(`${base()}/schedules/${missing}`)
      .set(authOwner())
      .send({ enabled: false })
      .expect(404);
    await request(app.getHttpServer())
      .delete(`${base()}/schedules/${missing}`)
      .set(authOwner())
      .expect(404);
  });

  it('RBAC: viewer cannot export or manage schedules (editor+ required)', async () => {
    await request(app.getHttpServer())
      .get(`${base()}/export?format=json`)
      .set(authViewer())
      .expect(403);
    await request(app.getHttpServer())
      .get(`${base()}/schedules`)
      .set(authViewer())
      .expect(403);
    await request(app.getHttpServer())
      .post(`${base()}/schedules`)
      .set(authViewer())
      .send({ cadence: 'weekly', format: 'json', deliverStorage: true })
      .expect(403);
  });
});
