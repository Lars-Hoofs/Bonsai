import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPg } from './helpers/pg';
import { buildTestApp } from './helpers/app';
import { TestIdp } from './helpers/oidc';
import { base32Decode, generateTotp } from '../src/two-factor/totp.util';

describe('two-factor (TOTP) e2e', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let idp: TestIdp;
  let token: string;

  beforeAll(async () => {
    ({ container, pool } = await startPg());
    ({ app, idp } = await buildTestApp(pool));
    token = await idp.sign({ sub: 'oidc|totp-user', email: 'totp@acme.eu' });
    // Mirror the user into the DB (AuthGuard upserts on any authenticated call).
    await request(app.getHttpServer())
      .get('/v1/tenants')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('requires authentication', async () => {
    await request(app.getHttpServer()).get('/v1/me/2fa/status').expect(401);
  });

  it('status starts disabled', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/me/2fa/status')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body).toEqual({ enabled: false });
  });

  it('full enroll -> verify -> status(enabled) -> disable flow, with the secret encrypted at rest', async () => {
    const enrollRes = await request(app.getHttpServer())
      .post('/v1/me/2fa/enroll')
      .set('Authorization', `Bearer ${token}`)
      .expect(201);

    const { otpauthUri, base32Secret } = enrollRes.body as {
      otpauthUri: string;
      base32Secret: string;
    };
    expect(typeof base32Secret).toBe('string');
    expect(base32Secret.length).toBeGreaterThan(10);
    expect(otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    expect(otpauthUri).toContain(`secret=${base32Secret}`);

    // Secret must be stored ENCRYPTED, not equal to the plaintext base32 secret.
    const dbRow = await pool.query(
      `SELECT secret_encrypted, enabled FROM user_totp WHERE user_id = (
         SELECT id FROM users WHERE oidc_subject = $1
       )`,
      ['oidc|totp-user'],
    );
    expect(dbRow.rowCount).toBe(1);
    const stored = dbRow.rows[0] as {
      secret_encrypted: string;
      enabled: boolean;
    };
    expect(stored.enabled).toBe(false);
    expect(stored.secret_encrypted).not.toBe(base32Secret);
    expect(stored.secret_encrypted).not.toContain(base32Secret);

    // Still disabled before verification.
    const statusBefore = await request(app.getHttpServer())
      .get('/v1/me/2fa/status')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(statusBefore.body).toEqual({ enabled: false });

    // Wrong code is rejected.
    await request(app.getHttpServer())
      .post('/v1/me/2fa/verify')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: '000000' })
      .expect(400);

    // Generate a correct code from the same secret (as a real authenticator app would).
    const secretBytes = base32Decode(base32Secret);
    const validCode = generateTotp(secretBytes);

    await request(app.getHttpServer())
      .post('/v1/me/2fa/verify')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: validCode })
      .expect(201)
      .expect(({ body }) => expect(body).toEqual({ enabled: true }));

    const statusAfter = await request(app.getHttpServer())
      .get('/v1/me/2fa/status')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(statusAfter.body).toEqual({ enabled: true });

    // Disabling with a wrong code fails and leaves it enabled.
    await request(app.getHttpServer())
      .post('/v1/me/2fa/disable')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: '111111' })
      .expect(400);

    const disableCode = generateTotp(secretBytes);
    await request(app.getHttpServer())
      .post('/v1/me/2fa/disable')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: disableCode })
      .expect(201)
      .expect(({ body }) => expect(body).toEqual({ enabled: false }));

    const statusFinal = await request(app.getHttpServer())
      .get('/v1/me/2fa/status')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(statusFinal.body).toEqual({ enabled: false });

    const dbRowAfter = await pool.query(
      `SELECT * FROM user_totp WHERE user_id = (
         SELECT id FROM users WHERE oidc_subject = $1
       )`,
      ['oidc|totp-user'],
    );
    expect(dbRowAfter.rowCount).toBe(0);
  });

  it('a second user has an isolated 2FA enrollment', async () => {
    const otherToken = await idp.sign({
      sub: 'oidc|totp-other',
      email: 'other@acme.eu',
    });
    await request(app.getHttpServer())
      .get('/v1/tenants')
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(200);

    const status = await request(app.getHttpServer())
      .get('/v1/me/2fa/status')
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(200);
    expect(status.body).toEqual({ enabled: false });
  });
});
