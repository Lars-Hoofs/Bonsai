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
});
