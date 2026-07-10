import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPg } from './helpers/pg';
import { buildTestApp } from './helpers/app';
import { TestIdp } from './helpers/oidc';

describe('invitations e2e', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let idp: TestIdp;
  let ownerToken: string;
  let tenantId: string;

  beforeAll(async () => {
    ({ container, pool } = await startPg());
    ({ app, idp } = await buildTestApp(pool));
    ownerToken = await idp.sign({ sub: 'oidc|owner', email: 'owner@acme.eu' });

    const res = await request(app.getHttpServer())
      .post('/v1/tenants')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'Acme', slug: 'acme-invites' })
      .expect(201);
    tenantId = (res.body as { id: string }).id;
  });

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('viewer cannot create invites (RBAC)', async () => {
    const viewerToken = await idp.sign({
      sub: 'oidc|viewer',
      email: 'viewer@acme.eu',
    });
    // Mirror the viewer user first.
    await request(app.getHttpServer())
      .get('/v1/tenants')
      .set('Authorization', `Bearer ${viewerToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/members`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'viewer@acme.eu', role: 'viewer' })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/invitations`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ email: 'invitee@acme.eu', role: 'editor' })
      .expect(403);
  });

  it('admin creates an invite; row + audit written; token in create response only', async () => {
    const res = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/invitations`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'invitee@acme.eu', role: 'editor' })
      .expect(201);
    expect(res.body).toMatchObject({
      email: 'invitee@acme.eu',
      role: 'editor',
      tenantId,
    });
    expect(typeof (res.body as { token: string }).token).toBe('string');
    expect((res.body as { token: string }).token.length).toBeGreaterThan(10);

    const dbRow = await pool.query(
      `SELECT email, role, token FROM invitations WHERE tenant_id = $1 AND email = $2`,
      [tenantId, 'invitee@acme.eu'],
    );
    expect(dbRow.rowCount).toBe(1);
    expect((dbRow.rows[0] as { token: string }).token).toBe(
      (res.body as { token: string }).token,
    );

    const audit = await pool.query(
      `SELECT action FROM audit_log WHERE action = 'invitation.created' AND tenant_id = $1`,
      [tenantId],
    );
    expect(audit.rowCount).toBe(1);

    const list = await request(app.getHttpServer())
      .get(`/v1/tenants/${tenantId}/invitations`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(list.body).toEqual([
      expect.objectContaining({ email: 'invitee@acme.eu', role: 'editor' }),
    ]);
    // Token must never leak via the list endpoint.
    expect((list.body as Array<{ token?: string }>)[0].token).toBeUndefined();
  });

  it('a second authenticated user accepts the invite and becomes a member', async () => {
    const createRes = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/invitations`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'newbie@acme.eu', role: 'agent' })
      .expect(201);
    const token = (createRes.body as { token: string }).token;

    const newbieToken = await idp.sign({
      sub: 'oidc|newbie',
      email: 'newbie@acme.eu',
    });
    // Mirror the new user in the DB (must be authenticated to accept).
    await request(app.getHttpServer())
      .get('/v1/tenants')
      .set('Authorization', `Bearer ${newbieToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .post('/v1/invitations/accept')
      .set('Authorization', `Bearer ${newbieToken}`)
      .send({ token })
      .expect(201);

    const list = await request(app.getHttpServer())
      .get('/v1/tenants')
      .set('Authorization', `Bearer ${newbieToken}`)
      .expect(200);
    expect(list.body).toEqual([
      expect.objectContaining({ id: tenantId, role: 'agent' }),
    ]);
  });

  it('rejects an invalid token with 404', async () => {
    const someToken = await idp.sign({
      sub: 'oidc|rando',
      email: 'rando@acme.eu',
    });
    await request(app.getHttpServer())
      .post('/v1/invitations/accept')
      .set('Authorization', `Bearer ${someToken}`)
      .send({ token: 'not-a-real-token' })
      .expect(404);
  });

  it('rejects an already-accepted token with 400', async () => {
    const createRes = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/invitations`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'reuse@acme.eu', role: 'viewer' })
      .expect(201);
    const token = (createRes.body as { token: string }).token;

    const reuseToken = await idp.sign({
      sub: 'oidc|reuse',
      email: 'reuse@acme.eu',
    });
    await request(app.getHttpServer())
      .get('/v1/tenants')
      .set('Authorization', `Bearer ${reuseToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .post('/v1/invitations/accept')
      .set('Authorization', `Bearer ${reuseToken}`)
      .send({ token })
      .expect(201);

    // Second acceptance attempt (even by a different user) is rejected.
    const anotherToken = await idp.sign({
      sub: 'oidc|another',
      email: 'another@acme.eu',
    });
    await request(app.getHttpServer())
      .get('/v1/tenants')
      .set('Authorization', `Bearer ${anotherToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .post('/v1/invitations/accept')
      .set('Authorization', `Bearer ${anotherToken}`)
      .send({ token })
      .expect(400);
  });

  it('rejects an expired invitation with 400', async () => {
    const createRes = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/invitations`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'expired@acme.eu', role: 'viewer' })
      .expect(201);
    const token = (createRes.body as { token: string }).token;

    // Force the invitation to be expired directly in the DB.
    await pool.query(
      `UPDATE invitations SET expires_at = now() - interval '1 day' WHERE token = $1`,
      [token],
    );

    const expiredToken = await idp.sign({
      sub: 'oidc|expired',
      email: 'expired@acme.eu',
    });
    await request(app.getHttpServer())
      .get('/v1/tenants')
      .set('Authorization', `Bearer ${expiredToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .post('/v1/invitations/accept')
      .set('Authorization', `Bearer ${expiredToken}`)
      .send({ token })
      .expect(400);
  });

  it('admin revokes a pending invite', async () => {
    const createRes = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/invitations`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'revoke-me@acme.eu', role: 'viewer' })
      .expect(201);
    const invitationId = (createRes.body as { id: string }).id;

    await request(app.getHttpServer())
      .delete(`/v1/tenants/${tenantId}/invitations/${invitationId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    const dbRow = await pool.query(`SELECT id FROM invitations WHERE id = $1`, [
      invitationId,
    ]);
    expect(dbRow.rowCount).toBe(0);
  });
});
