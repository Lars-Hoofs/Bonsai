import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPg } from './helpers/pg';
import { buildTestApp } from './helpers/app';
import { TestIdp } from './helpers/oidc';

interface SynonymBody {
  id: string;
  projectId: string;
  term: string;
  aliases: string[];
  createdAt: string;
}

describe('synonyms e2e', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let idp: TestIdp;
  let ownerToken: string;
  let viewerToken: string;
  let tenantId: string;
  let projectId: string;

  const base = (): string =>
    `/v1/tenants/${tenantId}/projects/${projectId}/synonyms`;
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
      .send({ name: 'Acme', slug: 'acme-synonyms' })
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

  it('creates a synonym and lists it', async () => {
    const created = await request(app.getHttpServer())
      .post(base())
      .set(authOwner())
      .send({ term: 'retour', aliases: ['terugsturen', 'retourneren'] })
      .expect(201);

    const body = created.body as SynonymBody;
    expect(body.term).toBe('retour');
    expect(body.aliases).toEqual(['terugsturen', 'retourneren']);
    expect(body.projectId).toBe(projectId);

    const list = await request(app.getHttpServer())
      .get(base())
      .set(authOwner())
      .expect(200);
    const listed = list.body as SynonymBody[];
    expect(listed.some((s) => s.id === body.id)).toBe(true);
  });

  it('rejects a duplicate term (case-insensitive) for the same project', async () => {
    await request(app.getHttpServer())
      .post(base())
      .set(authOwner())
      .send({ term: 'dupTerm', aliases: ['a'] })
      .expect(201);

    await request(app.getHttpServer())
      .post(base())
      .set(authOwner())
      .send({ term: 'DUPTERM', aliases: ['b'] })
      .expect(500);
  });

  it('deletes a synonym', async () => {
    const created = await request(app.getHttpServer())
      .post(base())
      .set(authOwner())
      .send({ term: 'deleteMe', aliases: ['x'] })
      .expect(201);
    const id = (created.body as SynonymBody).id;

    await request(app.getHttpServer())
      .delete(`${base()}/${id}`)
      .set(authOwner())
      .expect(200);

    const list = await request(app.getHttpServer())
      .get(base())
      .set(authOwner())
      .expect(200);
    expect((list.body as SynonymBody[]).some((s) => s.id === id)).toBe(false);
  });

  it('deleting a non-existent synonym returns 404', async () => {
    await request(app.getHttpServer())
      .delete(`${base()}/00000000-0000-0000-0000-000000000000`)
      .set(authOwner())
      .expect(404);
  });

  it('RBAC: viewer can list but cannot create or delete', async () => {
    await request(app.getHttpServer())
      .get(base())
      .set(authViewer())
      .expect(200);

    await request(app.getHttpServer())
      .post(base())
      .set(authViewer())
      .send({ term: 'blocked', aliases: ['x'] })
      .expect(403);

    const created = await request(app.getHttpServer())
      .post(base())
      .set(authOwner())
      .send({ term: 'viewerCannotDelete', aliases: ['x'] })
      .expect(201);
    const id = (created.body as SynonymBody).id;

    await request(app.getHttpServer())
      .delete(`${base()}/${id}`)
      .set(authViewer())
      .expect(403);
  });

  it('writes audit rows for synonym.created and synonym.deleted', async () => {
    const created = await request(app.getHttpServer())
      .post(base())
      .set(authOwner())
      .send({ term: 'auditedTerm', aliases: ['x'] })
      .expect(201);
    const id = (created.body as SynonymBody).id;

    await request(app.getHttpServer())
      .delete(`${base()}/${id}`)
      .set(authOwner())
      .expect(200);

    const audit = await pool.query<{ action: string; resource: string }>(
      `SELECT action, resource FROM audit_log WHERE resource = $1 ORDER BY created_at`,
      [`synonym:${id}`],
    );
    const actions = audit.rows.map((r) => r.action);
    expect(actions).toContain('synonym.created');
    expect(actions).toContain('synonym.deleted');
  });
});
