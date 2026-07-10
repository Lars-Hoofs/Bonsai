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
interface CopyView {
  defaultLocale: string;
  draft: Record<string, Record<string, string>>;
  published: Record<string, Record<string, string>> | null;
  publishedVersion: number;
}

describe('widget copy (editor) e2e', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let idp: TestIdp;
  let token: string;
  let tenantId: string;
  let projectId: string;

  const base = (): string =>
    `/v1/tenants/${tenantId}/projects/${projectId}/widget/copy`;
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
  }, 120000);

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('seeds Bonsai default copy, edits per-locale, and publishes with draft/published isolation', async () => {
    const initial = await request(app.getHttpServer())
      .get(base())
      .set(auth())
      .expect(200);
    const initialBody = initial.body as CopyView;
    expect(initialBody.defaultLocale).toBe('nl');
    expect(initialBody.draft.nl?.welcome).toBe('Hoi! Stel gerust je vraag.');
    expect(initialBody.published).toBeNull();
    expect(initialBody.publishedVersion).toBe(0);

    // Edit the draft copy + default locale.
    await request(app.getHttpServer())
      .put(base())
      .set(auth())
      .send({
        defaultLocale: 'en',
        copy: {
          en: { welcome: 'Welcome!' },
          fr: { welcome: 'Bienvenue!' },
        },
      })
      .expect(200);

    // Publish copies draft -> published and bumps the version.
    const published = await request(app.getHttpServer())
      .post(`${base()}/publish`)
      .set(auth())
      .expect(201);
    const publishedBody = published.body as CopyView;
    expect(publishedBody.publishedVersion).toBe(1);
    expect(publishedBody.defaultLocale).toBe('en');
    expect(publishedBody.published?.en?.welcome).toBe('Welcome!');

    // Further draft edits do NOT affect published until re-publish.
    await request(app.getHttpServer())
      .put(base())
      .set(auth())
      .send({ copy: { en: { welcome: 'Changed' } } })
      .expect(200);
    const after = await request(app.getHttpServer())
      .get(base())
      .set(auth())
      .expect(200);
    expect((after.body as CopyView).published?.en?.welcome).toBe('Welcome!');
    expect((after.body as CopyView).draft.en?.welcome).toBe('Changed');
  });

  it('rejects invalid copy payloads', async () => {
    await request(app.getHttpServer())
      .put(base())
      .set(auth())
      .send({ copy: { not_a_locale: { a: 'b' } } })
      .expect(400);
    await request(app.getHttpServer())
      .put(base())
      .set(auth())
      .send({ copy: { en: { welcome: 123 } } })
      .expect(400);
  });
});
