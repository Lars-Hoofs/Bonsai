import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPg } from './helpers/pg';
import { buildTestApp } from './helpers/app';
import { TestIdp } from './helpers/oidc';

describe('tenants e2e', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let idp: TestIdp;
  let ownerToken: string;
  let strangerToken: string;

  beforeAll(async () => {
    ({ container, pool } = await startPg());
    ({ app, idp } = await buildTestApp(pool));
    ownerToken = await idp.sign({ sub: 'oidc|owner', email: 'owner@acme.eu' });
    strangerToken = await idp.sign({
      sub: 'oidc|stranger',
      email: 'stranger@x.eu',
    });
  });
  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('rejects unauthenticated tenant creation', async () => {
    await request(app.getHttpServer())
      .post('/v1/tenants')
      .send({ name: 'A', slug: 'a' })
      .expect(401);
  });

  it('creates a tenant; creator becomes owner; audit written', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/tenants')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'Acme', slug: 'acme' })
      .expect(201);
    expect(res.body).toMatchObject({ name: 'Acme', slug: 'acme' });

    const list = await request(app.getHttpServer())
      .get('/v1/tenants')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(list.body).toEqual([
      expect.objectContaining({ slug: 'acme', role: 'owner' }),
    ]);

    const audit = await pool.query(
      `SELECT action FROM audit_log WHERE action = 'tenant.created'`,
    );
    expect(audit.rowCount).toBe(1);
  });

  it('non-members cannot list the tenant or add members', async () => {
    const list = await request(app.getHttpServer())
      .get('/v1/tenants')
      .set('Authorization', `Bearer ${strangerToken}`)
      .expect(200);
    expect(list.body).toEqual([]);

    const {
      rows: [t],
    } = await pool.query<{ id: string }>(
      `SELECT id FROM tenants WHERE slug = 'acme'`,
    );
    await request(app.getHttpServer())
      .post(`/v1/tenants/${t.id}/members`)
      .set('Authorization', `Bearer ${strangerToken}`)
      .send({ email: 'stranger@x.eu', role: 'admin' })
      .expect(403);
  });

  it('owner adds an existing user as member', async () => {
    const {
      rows: [t],
    } = await pool.query<{ id: string }>(
      `SELECT id FROM tenants WHERE slug = 'acme'`,
    );
    await request(app.getHttpServer())
      .post(`/v1/tenants/${t.id}/members`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'stranger@x.eu', role: 'agent' })
      .expect(201);
    const list = await request(app.getHttpServer())
      .get('/v1/tenants')
      .set('Authorization', `Bearer ${strangerToken}`)
      .expect(200);
    expect(list.body).toEqual([
      expect.objectContaining({ slug: 'acme', role: 'agent' }),
    ]);
  });

  it('404s when adding a member whose email has never logged in', async () => {
    const {
      rows: [t],
    } = await pool.query<{ id: string }>(
      `SELECT id FROM tenants WHERE slug = 'acme'`,
    );
    await request(app.getHttpServer())
      .post(`/v1/tenants/${t.id}/members`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'ghost@x.eu', role: 'agent' })
      .expect(404);
  });

  it('sub-admin member gets 403 when trying to add a tenant member', async () => {
    // Create a new tenant for this scenario to avoid state coupling
    await request(app.getHttpServer())
      .post('/v1/tenants')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'SubAdminTest', slug: 'subadmin-test' })
      .expect(201);

    const {
      rows: [tenantRow],
    } = await pool.query<{ id: string }>(
      `SELECT id FROM tenants WHERE slug = 'subadmin-test'`,
    );
    const tenantId = tenantRow.id;

    // Mint a token for an editor user
    const editorToken = await idp.sign({
      sub: 'oidc|editor',
      email: 'editor@acme.eu',
    });

    // Mirror the editor user in the database by calling an authenticated endpoint
    await request(app.getHttpServer())
      .get('/v1/tenants')
      .set('Authorization', `Bearer ${editorToken}`)
      .expect(200);

    // Owner adds the editor as a non-admin member (editor role) to the tenant
    await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/members`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'editor@acme.eu', role: 'editor' })
      .expect(201);

    // Now, as the editor (sub-admin), attempt to add a member and verify 403
    await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/members`)
      .set('Authorization', `Bearer ${editorToken}`)
      .send({ email: 'stranger@x.eu', role: 'viewer' })
      .expect(403);
  });
});
