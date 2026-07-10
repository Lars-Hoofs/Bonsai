import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPg } from './helpers/pg';
import { buildTestApp } from './helpers/app';
import { TestIdp } from './helpers/oidc';

interface TargetBody {
  id: string;
  projectId: string;
  kind: 'slack' | 'email';
  target: string;
  createdAt: string;
}

/**
 * Handover notification targets e2e (#38): admin-only CRUD of per-project
 * Slack incoming-webhook and email targets that fire on escalation.
 */
describe('handover notifications e2e', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let idp: TestIdp;
  let ownerToken: string;
  let agentToken: string;
  let tenantId: string;
  let projectId: string;

  const base = (): string =>
    `/v1/tenants/${tenantId}/projects/${projectId}/handover-notifications`;
  const authOwner = (): { Authorization: string } => ({
    Authorization: `Bearer ${ownerToken}`,
  });
  const authAgent = (): { Authorization: string } => ({
    Authorization: `Bearer ${agentToken}`,
  });

  beforeAll(async () => {
    ({ container, pool } = await startPg());
    ({ app, idp } = await buildTestApp(pool));
    ownerToken = await idp.sign({ sub: 'oidc|owner', email: 'owner@acme.eu' });
    agentToken = await idp.sign({ sub: 'oidc|agent', email: 'agent@acme.eu' });

    const t = await request(app.getHttpServer())
      .post('/v1/tenants')
      .set(authOwner())
      .send({ name: 'Acme', slug: 'acme-handover-notif' })
      .expect(201);
    tenantId = (t.body as { id: string }).id;

    const p = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/projects`)
      .set(authOwner())
      .send({ name: 'Bot', defaultLanguage: 'nl' })
      .expect(201);
    projectId = (p.body as { id: string }).id;

    // Register the agent (second user) then attach an agent membership.
    await request(app.getHttpServer())
      .get('/v1/tenants')
      .set(authAgent())
      .expect(200);
    await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/members`)
      .set(authOwner())
      .send({ email: 'agent@acme.eu', role: 'agent' })
      .expect(201);
  }, 120000);

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('creates a slack target and lists it', async () => {
    const created = await request(app.getHttpServer())
      .post(base())
      .set(authOwner())
      .send({ kind: 'slack', target: 'https://hooks.slack.example/T/B/X' })
      .expect(201);
    const body = created.body as TargetBody;
    expect(body.kind).toBe('slack');
    expect(body.target).toBe('https://hooks.slack.example/T/B/X');
    expect(body.projectId).toBe(projectId);

    const list = await request(app.getHttpServer())
      .get(base())
      .set(authOwner())
      .expect(200);
    expect((list.body as TargetBody[]).some((x) => x.id === body.id)).toBe(
      true,
    );
  });

  it('creates an email target', async () => {
    const created = await request(app.getHttpServer())
      .post(base())
      .set(authOwner())
      .send({ kind: 'email', target: 'ops@acme.eu' })
      .expect(201);
    expect((created.body as TargetBody).kind).toBe('email');
    expect((created.body as TargetBody).target).toBe('ops@acme.eu');
  });

  it('rejects a slack target that is not a URL', async () => {
    await request(app.getHttpServer())
      .post(base())
      .set(authOwner())
      .send({ kind: 'slack', target: 'not-a-url' })
      .expect(400);
  });

  it('rejects an email target that is not an email', async () => {
    await request(app.getHttpServer())
      .post(base())
      .set(authOwner())
      .send({ kind: 'email', target: 'https://nope.example' })
      .expect(400);
  });

  it('rejects an unknown kind', async () => {
    await request(app.getHttpServer())
      .post(base())
      .set(authOwner())
      .send({ kind: 'sms', target: '+3112345678' })
      .expect(400);
  });

  it('deletes a target', async () => {
    const created = await request(app.getHttpServer())
      .post(base())
      .set(authOwner())
      .send({ kind: 'email', target: 'delete@acme.eu' })
      .expect(201);
    const id = (created.body as TargetBody).id;

    await request(app.getHttpServer())
      .delete(`${base()}/${id}`)
      .set(authOwner())
      .expect(200);

    const list = await request(app.getHttpServer())
      .get(base())
      .set(authOwner())
      .expect(200);
    expect((list.body as TargetBody[]).some((x) => x.id === id)).toBe(false);
  });

  it('deleting a non-existent target returns 404', async () => {
    await request(app.getHttpServer())
      .delete(`${base()}/00000000-0000-0000-0000-000000000000`)
      .set(authOwner())
      .expect(404);
  });

  it('RBAC: an agent (below admin) cannot list, create, or delete', async () => {
    await request(app.getHttpServer()).get(base()).set(authAgent()).expect(403);
    await request(app.getHttpServer())
      .post(base())
      .set(authAgent())
      .send({ kind: 'email', target: 'x@acme.eu' })
      .expect(403);
    await request(app.getHttpServer())
      .delete(`${base()}/00000000-0000-0000-0000-000000000000`)
      .set(authAgent())
      .expect(403);
  });
});
