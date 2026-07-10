import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPg } from './helpers/pg';
import { buildTestApp } from './helpers/app';
import { TestIdp } from './helpers/oidc';

interface ConnectorBody {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  baseUrl: string;
  method: string;
  hasAuth: boolean;
  requestSchema: Record<string, unknown>;
  responseTemplate: string | null;
  usageHint: string | null;
  createdAt: string;
  updatedAt: string;
}

describe('connectors e2e', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let idp: TestIdp;
  let ownerToken: string;
  let viewerToken: string;
  let tenantId: string;
  let projectId: string;
  let schemaName: string;

  const base = (): string =>
    `/v1/tenants/${tenantId}/projects/${projectId}/connectors`;
  const authOwner = (): { Authorization: string } => ({
    Authorization: `Bearer ${ownerToken}`,
  });
  const authViewer = (): { Authorization: string } => ({
    Authorization: `Bearer ${viewerToken}`,
  });

  const SECRET_TOKEN = 'super-secret-token-value-12345';

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
      .send({ name: 'Acme', slug: 'acme-connectors' })
      .expect(201);
    tenantId = (t.body as { id: string }).id;

    const p = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/projects`)
      .set(authOwner())
      .send({ name: 'Bot', defaultLanguage: 'nl' })
      .expect(201);
    projectId = (p.body as { id: string }).id;

    const {
      rows: [{ schema_name }],
    } = await pool.query<{ schema_name: string }>(
      `SELECT schema_name FROM tenants WHERE id = $1`,
      [tenantId],
    );
    schemaName = schema_name;

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

  it('creates a connector with auth: response has hasAuth true and never the token; DB row is encrypted', async () => {
    const created = await request(app.getHttpServer())
      .post(base())
      .set(authOwner())
      .send({
        name: 'Order status API',
        description: 'Looks up order status by order id',
        baseUrl: 'https://api.example.com/orders',
        method: 'GET',
        requestSchema: { orderId: { type: 'string' } },
        usageHint: 'Use this to look up an order status',
        auth: { type: 'bearer', token: SECRET_TOKEN },
      })
      .expect(201);

    const body = created.body as ConnectorBody;
    expect(body.name).toBe('Order status API');
    expect(body.hasAuth).toBe(true);
    expect(body).not.toHaveProperty('auth');
    expect(body).not.toHaveProperty('auth_encrypted');
    expect(body).not.toHaveProperty('authEncrypted');
    expect(JSON.stringify(body)).not.toContain(SECRET_TOKEN);

    // Query the DB row directly: auth_encrypted must be present and must
    // NOT contain the plaintext token.
    const { rows } = await pool.query<{
      auth_encrypted: string | null;
      base_url: string;
    }>(
      `SELECT auth_encrypted, base_url FROM "${schemaName}".api_connectors WHERE id = $1`,
      [body.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].auth_encrypted).toBeTruthy();
    expect(rows[0].auth_encrypted).not.toContain(SECRET_TOKEN);
    expect(rows[0].base_url).toBe('https://api.example.com/orders');

    // List omits credentials.
    const list = await request(app.getHttpServer())
      .get(base())
      .set(authOwner())
      .expect(200);
    const listed = (list.body as ConnectorBody[])[0];
    expect(listed.hasAuth).toBe(true);
    expect(JSON.stringify(listed)).not.toContain(SECRET_TOKEN);

    // Get by id omits credentials too.
    const got = await request(app.getHttpServer())
      .get(`${base()}/${body.id}`)
      .set(authOwner())
      .expect(200);
    expect(JSON.stringify(got.body)).not.toContain(SECRET_TOKEN);
    expect((got.body as ConnectorBody).hasAuth).toBe(true);
  });

  it('creates a connector without auth: hasAuth is false', async () => {
    const created = await request(app.getHttpServer())
      .post(base())
      .set(authOwner())
      .send({
        name: 'Public weather API',
        baseUrl: 'https://api.example.com/weather',
        method: 'GET',
      })
      .expect(201);
    expect((created.body as ConnectorBody).hasAuth).toBe(false);
  });

  it('updates a connector, re-encrypting auth when provided', async () => {
    const created = await request(app.getHttpServer())
      .post(base())
      .set(authOwner())
      .send({
        name: 'To update',
        baseUrl: 'https://api.example.com/x',
        method: 'GET',
      })
      .expect(201);
    const id = (created.body as ConnectorBody).id;
    expect((created.body as ConnectorBody).hasAuth).toBe(false);

    const updated = await request(app.getHttpServer())
      .patch(`${base()}/${id}`)
      .set(authOwner())
      .send({ auth: { type: 'header', name: 'X-Api-Key', value: 'k123' } })
      .expect(200);
    expect((updated.body as ConnectorBody).hasAuth).toBe(true);
    expect(JSON.stringify(updated.body)).not.toContain('k123');
  });

  it('RBAC: viewer cannot POST (403); delete requires admin', async () => {
    await request(app.getHttpServer())
      .post(base())
      .set(authViewer())
      .send({
        name: 'Blocked',
        baseUrl: 'https://api.example.com/blocked',
        method: 'GET',
      })
      .expect(403);

    const created = await request(app.getHttpServer())
      .post(base())
      .set(authOwner())
      .send({
        name: 'Deletable',
        baseUrl: 'https://api.example.com/deletable',
        method: 'GET',
      })
      .expect(201);
    const id = (created.body as ConnectorBody).id;

    // Owner has role 'owner' which outranks 'admin' so should be allowed;
    // viewer must be rejected.
    await request(app.getHttpServer())
      .delete(`${base()}/${id}`)
      .set(authViewer())
      .expect(403);

    await request(app.getHttpServer())
      .delete(`${base()}/${id}`)
      .set(authOwner())
      .expect(200);

    await request(app.getHttpServer())
      .get(`${base()}/${id}`)
      .set(authOwner())
      .expect(404);
  });

  it('writes audit rows for connector.created and connector.deleted', async () => {
    const created = await request(app.getHttpServer())
      .post(base())
      .set(authOwner())
      .send({
        name: 'Audited connector',
        baseUrl: 'https://api.example.com/audited',
        method: 'GET',
      })
      .expect(201);
    const id = (created.body as ConnectorBody).id;

    await request(app.getHttpServer())
      .delete(`${base()}/${id}`)
      .set(authOwner())
      .expect(200);

    const audit = await pool.query<{ action: string; resource: string }>(
      `SELECT action, resource FROM audit_log WHERE resource = $1 ORDER BY created_at`,
      [`connector:${id}`],
    );
    const actions = audit.rows.map((r) => r.action);
    expect(actions).toContain('connector.created');
    expect(actions).toContain('connector.deleted');
  });

  it('rejects an invalid base_url', async () => {
    await request(app.getHttpServer())
      .post(base())
      .set(authOwner())
      .send({ name: 'Bad', baseUrl: 'not-a-url', method: 'GET' })
      .expect(400);
  });
});
