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
interface TargetingRule {
  mode: 'show' | 'hide';
  matchType: 'glob' | 'regex';
  pattern: string;
}
interface ThemeView {
  draft: { window?: { accent?: string } };
  published: { window?: { accent?: string } } | null;
  publishedVersion: number;
  targeting: {
    draft: { defaultShow: boolean; rules: TargetingRule[] };
    published: { defaultShow: boolean; rules: TargetingRule[] } | null;
  };
  triggers: {
    draft: {
      afterSeconds: number | null;
      scrollDepth: number | null;
      exitIntent: boolean;
    };
    published: {
      afterSeconds: number | null;
      scrollDepth: number | null;
      exitIntent: boolean;
    } | null;
  };
}

describe('widget theme e2e', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let idp: TestIdp;
  let token: string;
  let tenantId: string;
  let projectId: string;

  const base = (): string =>
    `/v1/tenants/${tenantId}/projects/${projectId}/widget`;
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

  it('seeds the Bonsai default draft, edits, and publishes with draft/published isolation', async () => {
    const initial = await request(app.getHttpServer())
      .get(`${base()}/theme`)
      .set(auth())
      .expect(200);
    expect((initial.body as ThemeView).draft.window?.accent).toBe('#7C3AED');
    expect((initial.body as ThemeView).published).toBeNull();
    expect((initial.body as ThemeView).publishedVersion).toBe(0);

    // Published theme is not available until first publish.
    await request(app.getHttpServer())
      .get(`${base()}/theme/published`)
      .set(auth())
      .expect(404);

    // Edit the draft.
    await request(app.getHttpServer())
      .put(`${base()}/theme`)
      .set(auth())
      .send({ theme: { window: { accent: '#FF0000' } } })
      .expect(200);

    // Publishing bumps the version and copies draft -> published.
    const published = await request(app.getHttpServer())
      .post(`${base()}/theme/publish`)
      .set(auth())
      .expect(201);
    expect((published.body as ThemeView).publishedVersion).toBe(1);
    expect((published.body as ThemeView).published?.window?.accent).toBe(
      '#FF0000',
    );

    // Further draft edits do NOT change the published theme until re-publish.
    await request(app.getHttpServer())
      .put(`${base()}/theme`)
      .set(auth())
      .send({ theme: { window: { accent: '#00FF00' } } })
      .expect(200);
    const live = await request(app.getHttpServer())
      .get(`${base()}/theme/published`)
      .set(auth())
      .expect(200);
    expect(
      (live.body as { theme: { window?: { accent?: string } } }).theme.window
        ?.accent,
    ).toBe('#FF0000');
  });

  it('edits and publishes page-targeting rules (#11) and proactive triggers (#12)', async () => {
    // Fresh config starts with permissive defaults.
    const initial = await request(app.getHttpServer())
      .get(`${base()}/theme`)
      .set(auth())
      .expect(200);
    expect((initial.body as ThemeView).targeting.draft).toEqual({
      defaultShow: true,
      rules: [],
    });
    expect((initial.body as ThemeView).triggers.draft).toEqual({
      afterSeconds: null,
      scrollDepth: null,
      exitIntent: false,
    });

    // Editors set targeting rules.
    const savedTargeting = await request(app.getHttpServer())
      .put(`${base()}/targeting`)
      .set(auth())
      .send({
        defaultShow: false,
        rules: [
          { mode: 'show', matchType: 'glob', pattern: '/help/*' },
          { mode: 'hide', matchType: 'regex', pattern: '^/admin/' },
        ],
      })
      .expect(200);
    expect(
      (savedTargeting.body as ThemeView).targeting.draft.rules,
    ).toHaveLength(2);

    // Editors set proactive triggers.
    await request(app.getHttpServer())
      .put(`${base()}/triggers`)
      .set(auth())
      .send({ afterSeconds: 15, scrollDepth: 60, exitIntent: true })
      .expect(200);

    // Invalid config is rejected.
    await request(app.getHttpServer())
      .put(`${base()}/triggers`)
      .set(auth())
      .send({ scrollDepth: 500 })
      .expect(400);
    await request(app.getHttpServer())
      .put(`${base()}/targeting`)
      .set(auth())
      .send({ rules: [{ mode: 'show', matchType: 'regex', pattern: '([' }] })
      .expect(400);

    // The draft edits do not change published until publish. (An earlier test
    // in this suite already published once, so published holds the prior
    // permissive defaults — not these new drafts — at this point.)
    const beforePublish = await request(app.getHttpServer())
      .get(`${base()}/theme`)
      .set(auth())
      .expect(200);
    expect((beforePublish.body as ThemeView).targeting.published).toEqual({
      defaultShow: true,
      rules: [],
    });
    expect((beforePublish.body as ThemeView).triggers.published).toEqual({
      afterSeconds: null,
      scrollDepth: null,
      exitIntent: false,
    });

    // Publishing promotes theme + targeting + triggers together.
    await request(app.getHttpServer())
      .post(`${base()}/theme/publish`)
      .set(auth())
      .expect(201);
    const afterPublish = await request(app.getHttpServer())
      .get(`${base()}/theme`)
      .set(auth())
      .expect(200);
    expect(
      (afterPublish.body as ThemeView).targeting.published?.defaultShow,
    ).toBe(false);
    expect(
      (afterPublish.body as ThemeView).targeting.published?.rules,
    ).toHaveLength(2);
    expect((afterPublish.body as ThemeView).triggers.published).toEqual({
      afterSeconds: 15,
      scrollDepth: 60,
      exitIntent: true,
    });
  });
});
