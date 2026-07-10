import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPg } from './helpers/pg';
import { buildTestApp } from './helpers/app';
import { TestIdp } from './helpers/oidc';

interface IdBody {
  id: string;
}
interface CopyDelivery {
  version: number;
  locale: string;
  defaultLocale: string;
  copy: Record<string, string>;
}

describe('public widget copy delivery e2e', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let idp: TestIdp;
  let token: string;
  let tenantId: string;
  let projectId: string;
  let widgetKey: string;
  const ORIGIN = 'https://klant.example';

  const auth = (): { Authorization: string } => ({
    Authorization: `Bearer ${token}`,
  });

  beforeAll(async () => {
    ({ container, pool } = await startPg());
    ({ app, idp } = await buildTestApp(pool));
    token = await idp.sign({ sub: 'oidc|u1', email: 'u1@acme.eu' });
    const t = await request(app.getHttpServer())
      .post('/v1/tenants')
      .set(auth())
      .send({ name: 'Acme', slug: 'acme' })
      .expect(201);
    tenantId = (t.body as IdBody).id;
    const p = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/projects`)
      .set(auth())
      .send({ name: 'Bot' })
      .expect(201);
    projectId = (p.body as IdBody).id;

    const copyBase = `/v1/tenants/${tenantId}/projects/${projectId}/widget/copy`;
    await request(app.getHttpServer())
      .put(copyBase)
      .set(auth())
      .send({
        defaultLocale: 'nl',
        copy: {
          nl: { welcome: 'Hoi' },
          en: { welcome: 'Hi' },
          'pt-br': { welcome: 'Ola' },
        },
      })
      .expect(200);
    await request(app.getHttpServer())
      .post(`${copyBase}/publish`)
      .set(auth())
      .expect(201);

    // Publish a theme too, so /widget/config has a base to return.
    await request(app.getHttpServer())
      .post(
        `/v1/tenants/${tenantId}/projects/${projectId}/widget/theme/publish`,
      )
      .set(auth())
      .expect(201);

    const key = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/api-keys`)
      .set(auth())
      .send({
        name: 'widget',
        kind: 'public_widget',
        projectId,
        allowedOrigins: [ORIGIN],
      })
      .expect(201);
    widgetKey = (key.body as { key: string }).key;
  }, 120000);

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('serves copy for an explicit ?locale=', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/widget/copy?locale=en')
      .set('x-bonsai-key', widgetKey)
      .set('Origin', ORIGIN)
      .expect(200);
    const body = res.body as CopyDelivery;
    expect(body.locale).toBe('en');
    expect(body.defaultLocale).toBe('nl');
    expect(body.copy.welcome).toBe('Hi');
    expect(body.version).toBe(1);
  });

  it('negotiates via Accept-Language, matching regional to primary subtag', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/widget/copy')
      .set('x-bonsai-key', widgetKey)
      .set('Origin', ORIGIN)
      .set('Accept-Language', 'en-US,en;q=0.9,nl;q=0.5')
      .expect(200);
    expect((res.body as CopyDelivery).locale).toBe('en');
  });

  it('explicit ?locale= wins over Accept-Language', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/widget/copy?locale=en')
      .set('x-bonsai-key', widgetKey)
      .set('Origin', ORIGIN)
      .set('Accept-Language', 'nl')
      .expect(200);
    expect((res.body as CopyDelivery).locale).toBe('en');
  });

  it('falls back to the default locale when nothing matches', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/widget/copy?locale=de')
      .set('x-bonsai-key', widgetKey)
      .set('Origin', ORIGIN)
      .expect(200);
    expect((res.body as CopyDelivery).locale).toBe('nl');
    expect((res.body as CopyDelivery).copy.welcome).toBe('Hoi');
  });

  it('embeds negotiated copy in /widget/config', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/widget/config?locale=en')
      .set('x-bonsai-key', widgetKey)
      .set('Origin', ORIGIN)
      .expect(200);
    const body = res.body as {
      version: number;
      theme: Record<string, unknown>;
      copy: CopyDelivery | null;
    };
    expect(body.theme).toBeDefined();
    expect(body.copy?.locale).toBe('en');
    expect(body.copy?.copy.welcome).toBe('Hi');
  });

  it('rejects a disallowed origin and unknown key', async () => {
    await request(app.getHttpServer())
      .get('/v1/widget/copy')
      .set('x-bonsai-key', widgetKey)
      .set('Origin', 'https://evil.example')
      .expect(401);
    await request(app.getHttpServer())
      .get('/v1/widget/copy')
      .set('x-bonsai-key', 'bsk_nonsense')
      .set('Origin', ORIGIN)
      .expect(401);
  });
});
