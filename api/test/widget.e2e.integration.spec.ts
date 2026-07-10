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
interface ThemeView {
  draft: { window?: { accent?: string } };
  published: { window?: { accent?: string } } | null;
  publishedVersion: number;
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

  it('rejects an invalid theme on PUT (bad hex color)', async () => {
    await request(app.getHttpServer())
      .put(`${base()}/theme`)
      .set(auth())
      .send({ theme: { colors: { primary: 'not-a-hex' } } })
      .expect(400);
  });

  it('rejects an oversized theme on PUT (> 32KB serialized)', async () => {
    await request(app.getHttpServer())
      .put(`${base()}/theme`)
      .set(auth())
      .send({ theme: { customCss: 'a'.repeat(33_000) } })
      .expect(400);
  });

  it('lists the 3 built-in presets', async () => {
    const res = await request(app.getHttpServer())
      .get(`${base()}/theme/presets`)
      .set(auth())
      .expect(200);
    const presets = res.body as Array<{ name: string; label: string }>;
    expect(presets).toHaveLength(3);
    expect(presets.map((p) => p.name).sort()).toEqual([
      'bonsai-default',
      'dark',
      'minimal',
    ]);
  });

  it('applying a preset replaces the draft with that preset theme', async () => {
    await request(app.getHttpServer())
      .post(`${base()}/theme/apply-preset`)
      .set(auth())
      .send({ preset: 'dark' })
      .expect(201);

    const view = await request(app.getHttpServer())
      .get(`${base()}/theme`)
      .set(auth())
      .expect(200);
    const draft = (view.body as { draft: { colors?: { background?: string } } })
      .draft;
    expect(draft.colors?.background).toBe('#0F172A');
  });

  it('rejects an unknown preset name', async () => {
    await request(app.getHttpServer())
      .post(`${base()}/theme/apply-preset`)
      .set(auth())
      .send({ preset: 'neon' })
      .expect(400);
  });

  it('export then import round-trips the draft theme', async () => {
    await request(app.getHttpServer())
      .post(`${base()}/theme/apply-preset`)
      .set(auth())
      .send({ preset: 'minimal' })
      .expect(201);

    const exported = await request(app.getHttpServer())
      .get(`${base()}/theme/export`)
      .set(auth())
      .expect(200);
    const theme = (exported.body as { theme: Record<string, unknown> }).theme;
    expect(theme.radius).toBe(8);

    // Switch away, then import the exported theme back.
    await request(app.getHttpServer())
      .post(`${base()}/theme/apply-preset`)
      .set(auth())
      .send({ preset: 'dark' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`${base()}/theme/import`)
      .set(auth())
      .send({ theme })
      .expect(201);

    const roundTripped = await request(app.getHttpServer())
      .get(`${base()}/theme`)
      .set(auth())
      .expect(200);
    expect(
      (roundTripped.body as { draft: Record<string, unknown> }).draft,
    ).toEqual(theme);
  });

  it('reports a low-contrast warning on save/publish and via GET contrast', async () => {
    await request(app.getHttpServer())
      .put(`${base()}/theme`)
      .set(auth())
      .send({
        theme: { colors: { text: '#DDDDDD', background: '#FFFFFF' } },
      })
      .expect(200)
      .then((res) => {
        const body = res.body as { contrastWarnings: string[] };
        expect(body.contrastWarnings.length).toBeGreaterThan(0);
      });

    const publishRes = await request(app.getHttpServer())
      .post(`${base()}/theme/publish`)
      .set(auth())
      .expect(201);
    expect(
      (publishRes.body as { contrastWarnings: string[] }).contrastWarnings
        .length,
    ).toBeGreaterThan(0);

    const contrast = await request(app.getHttpServer())
      .get(`${base()}/theme/contrast`)
      .set(auth())
      .expect(200);
    const body = contrast.body as {
      result: { ratio: number; passesAA: boolean } | null;
    };
    expect(body.result).not.toBeNull();
    expect(body.result?.passesAA).toBe(false);
  });

  it('issues a preview token that resolves to the current draft on the public endpoint', async () => {
    await request(app.getHttpServer())
      .post(`${base()}/theme/apply-preset`)
      .set(auth())
      .send({ preset: 'minimal' })
      .expect(201);

    const tokenRes = await request(app.getHttpServer())
      .post(`${base()}/theme/preview-token`)
      .set(auth())
      .expect(201);
    const previewToken = (tokenRes.body as { token: string }).token;
    expect(typeof previewToken).toBe('string');

    const preview = await request(app.getHttpServer())
      .get(`/v1/widget/preview`)
      .query({ token: previewToken })
      .expect(200);
    const theme = (preview.body as { theme: Record<string, unknown> }).theme;
    expect(theme.radius).toBe(8);
  });
});
