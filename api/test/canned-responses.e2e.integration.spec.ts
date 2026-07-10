import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPg } from './helpers/pg';
import { buildTestApp } from './helpers/app';
import { TestIdp } from './helpers/oidc';

interface CannedResponseBody {
  id: string;
  projectId: string;
  title: string;
  body: string;
  variables: string[];
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RenderBody {
  id: string;
  title: string;
  body: string;
  rendered: string;
}

describe('canned responses e2e', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let idp: TestIdp;
  let ownerToken: string;
  let agentToken: string;
  let viewerToken: string;
  let tenantId: string;
  let projectId: string;

  const base = (): string =>
    `/v1/tenants/${tenantId}/projects/${projectId}/canned-responses`;
  const auth = (t: string): { Authorization: string } => ({
    Authorization: `Bearer ${t}`,
  });

  beforeAll(async () => {
    ({ container, pool } = await startPg());
    ({ app, idp } = await buildTestApp(pool));
    ownerToken = await idp.sign({ sub: 'oidc|owner', email: 'owner@acme.eu' });
    agentToken = await idp.sign({ sub: 'oidc|agent', email: 'agent@acme.eu' });
    viewerToken = await idp.sign({
      sub: 'oidc|viewer',
      email: 'viewer@acme.eu',
    });

    const t = await request(app.getHttpServer())
      .post('/v1/tenants')
      .set(auth(ownerToken))
      .send({ name: 'Acme', slug: 'acme-canned' })
      .expect(201);
    tenantId = (t.body as { id: string }).id;

    const p = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/projects`)
      .set(auth(ownerToken))
      .send({ name: 'Bot', defaultLanguage: 'nl' })
      .expect(201);
    projectId = (p.body as { id: string }).id;

    // Register + attach agent and viewer memberships (each user must have hit
    // the API once so it exists before it can be added as a member).
    await request(app.getHttpServer())
      .get('/v1/tenants')
      .set(auth(agentToken))
      .expect(200);
    await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/members`)
      .set(auth(ownerToken))
      .send({ email: 'agent@acme.eu', role: 'agent' })
      .expect(201);

    await request(app.getHttpServer())
      .get('/v1/tenants')
      .set(auth(viewerToken))
      .expect(200);
    await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/members`)
      .set(auth(ownerToken))
      .send({ email: 'viewer@acme.eu', role: 'viewer' })
      .expect(201);
  }, 120000);

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('an agent creates a canned response and lists it', async () => {
    const created = await request(app.getHttpServer())
      .post(base())
      .set(auth(agentToken))
      .send({
        title: 'Greeting',
        body: 'Hi {{customer_name}}, thanks for reaching out!',
        variables: ['customer_name'],
      })
      .expect(201);

    const body = created.body as CannedResponseBody;
    expect(body.title).toBe('Greeting');
    expect(body.variables).toEqual(['customer_name']);
    expect(body.projectId).toBe(projectId);
    expect(body.createdBy).toBeTruthy();

    const list = await request(app.getHttpServer())
      .get(base())
      .set(auth(agentToken))
      .expect(200);
    expect(
      (list.body as CannedResponseBody[]).some((c) => c.id === body.id),
    ).toBe(true);
  });

  it('defaults variables to an empty array when omitted', async () => {
    const created = await request(app.getHttpServer())
      .post(base())
      .set(auth(agentToken))
      .send({ title: 'No vars', body: 'Static text' })
      .expect(201);
    expect((created.body as CannedResponseBody).variables).toEqual([]);
  });

  it('updates a canned response', async () => {
    const created = await request(app.getHttpServer())
      .post(base())
      .set(auth(agentToken))
      .send({ title: 'Editable', body: 'v1' })
      .expect(201);
    const id = (created.body as CannedResponseBody).id;

    const updated = await request(app.getHttpServer())
      .patch(`${base()}/${id}`)
      .set(auth(agentToken))
      .send({ body: 'v2', variables: ['x'] })
      .expect(200);
    const body = updated.body as CannedResponseBody;
    expect(body.title).toBe('Editable');
    expect(body.body).toBe('v2');
    expect(body.variables).toEqual(['x']);
  });

  it('renders placeholders, leaving unknown ones intact', async () => {
    const created = await request(app.getHttpServer())
      .post(base())
      .set(auth(agentToken))
      .send({
        title: 'Order status',
        body: 'Hi {{name}}, order {{order_id}} ships soon.',
        variables: ['name', 'order_id'],
      })
      .expect(201);
    const id = (created.body as CannedResponseBody).id;

    const res = await request(app.getHttpServer())
      .post(`${base()}/${id}/render`)
      .set(auth(agentToken))
      .send({ values: { name: 'Ada' } })
      .expect(201);
    const body = res.body as RenderBody;
    expect(body.rendered).toBe('Hi Ada, order {{order_id}} ships soon.');
  });

  it('rejects a duplicate title (case-insensitive) with 409', async () => {
    await request(app.getHttpServer())
      .post(base())
      .set(auth(agentToken))
      .send({ title: 'DupTitle', body: 'a' })
      .expect(201);

    await request(app.getHttpServer())
      .post(base())
      .set(auth(agentToken))
      .send({ title: 'duptitle', body: 'b' })
      .expect(409);
  });

  it('deletes a canned response; deleting a missing one returns 404', async () => {
    const created = await request(app.getHttpServer())
      .post(base())
      .set(auth(agentToken))
      .send({ title: 'DeleteMe', body: 'x' })
      .expect(201);
    const id = (created.body as CannedResponseBody).id;

    await request(app.getHttpServer())
      .delete(`${base()}/${id}`)
      .set(auth(agentToken))
      .expect(200);

    await request(app.getHttpServer())
      .delete(`${base()}/${id}`)
      .set(auth(agentToken))
      .expect(404);
  });

  it('rejects invalid variable names', async () => {
    await request(app.getHttpServer())
      .post(base())
      .set(auth(agentToken))
      .send({ title: 'BadVar', body: 'x', variables: ['has space'] })
      .expect(400);
  });

  it('RBAC: a viewer (below agent) cannot list or create', async () => {
    await request(app.getHttpServer())
      .get(base())
      .set(auth(viewerToken))
      .expect(403);

    await request(app.getHttpServer())
      .post(base())
      .set(auth(viewerToken))
      .send({ title: 'Blocked', body: 'x' })
      .expect(403);
  });

  it("does not let another tenant reach this tenant's library", async () => {
    const otherToken = await idp.sign({
      sub: 'oidc|other',
      email: 'other@else.eu',
    });
    await request(app.getHttpServer())
      .get(base())
      .set(auth(otherToken))
      .expect(403);
  });

  it('writes audit rows for created and deleted', async () => {
    const created = await request(app.getHttpServer())
      .post(base())
      .set(auth(agentToken))
      .send({ title: 'Audited', body: 'x' })
      .expect(201);
    const id = (created.body as CannedResponseBody).id;

    await request(app.getHttpServer())
      .delete(`${base()}/${id}`)
      .set(auth(agentToken))
      .expect(200);

    const audit = await pool.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE resource = $1 ORDER BY created_at`,
      [`canned_response:${id}`],
    );
    const actions = audit.rows.map((r) => r.action);
    expect(actions).toContain('canned_response.created');
    expect(actions).toContain('canned_response.deleted');
  });
});
