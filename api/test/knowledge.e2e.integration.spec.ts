import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPg } from './helpers/pg';
import { buildTestApp } from './helpers/app';
import { TestIdp } from './helpers/oidc';

interface SourceBody {
  id: string;
  status: string;
  recrawlIntervalMs: number | null;
}
interface HealthRow {
  id: string;
  status: string;
  documentCount: number;
  chunkCount: number;
  failedDocumentCount: number;
  recrawlIntervalMs: number | null;
}
interface DocListItem {
  id: string;
  title: string;
  chunkCount: number;
  enabled: boolean;
}
interface DocBody {
  enabled: boolean;
  chunks: { ordinal: number; text: string; tokenCount: number }[];
}

describe('knowledge base e2e', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let idp: TestIdp;
  let token: string;
  let tenantId: string;
  let projectId: string;

  const base = (): string =>
    `/v1/tenants/${tenantId}/projects/${projectId}/knowledge`;
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
    tenantId = (t.body as { id: string }).id;
    const p = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/projects`)
      .set(auth())
      .send({ name: 'Bot' })
      .expect(201);
    projectId = (p.body as { id: string }).id;
  });
  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('ingests a manual source into processed, chunked, embedded documents', async () => {
    const body = Array.from({ length: 120 }, (_, i) => `zin${i}`).join(' ');
    const res = await request(app.getHttpServer())
      .post(`${base()}/sources`)
      .set(auth())
      .send({
        type: 'manual',
        name: 'Handmatig artikel',
        config: { title: 'Openingstijden', body, language: 'nl' },
      })
      .expect(201);
    expect((res.body as SourceBody).status).toBe('processed');

    const docs = await request(app.getHttpServer())
      .get(`${base()}/documents`)
      .set(auth())
      .expect(200);
    const docList = docs.body as DocListItem[];
    expect(docList).toHaveLength(1);
    expect(docList[0].chunkCount).toBeGreaterThan(0);

    const doc = await request(app.getHttpServer())
      .get(`${base()}/documents/${docList[0].id}`)
      .set(auth())
      .expect(200);
    const docBody = doc.body as DocBody;
    expect(docBody.chunks[0].ordinal).toBe(0);
    expect(docBody.chunks[0].text.length).toBeGreaterThan(0);
  });

  it('ingests a CSV source into one document per row', async () => {
    const csv =
      'vraag,antwoord\nWat kost verzending?,Gratis boven 50 euro\nRetour?,Binnen 30 dagen';
    const res = await request(app.getHttpServer())
      .post(`${base()}/sources`)
      .set(auth())
      .send({
        type: 'csv',
        name: 'FAQ',
        config: { csv, titleColumn: 'vraag', bodyColumns: ['antwoord'] },
      })
      .expect(201);
    const sourceId = (res.body as SourceBody).id;

    const docs = await request(app.getHttpServer())
      .get(`${base()}/documents?sourceId=${sourceId}`)
      .set(auth())
      .expect(200);
    const docList = docs.body as DocListItem[];
    expect(docList).toHaveLength(2);
    expect(docList.map((d) => d.title)).toEqual(
      expect.arrayContaining(['Wat kost verzending?', 'Retour?']),
    );
  });

  it('rejects unknown config fields via forbidNonWhitelisted', async () => {
    await request(app.getHttpServer())
      .post(`${base()}/sources`)
      .set(auth())
      .send({ type: 'manual', name: 'x', config: {}, bogus: 1 })
      .expect(400);
  });

  it('reprocess is idempotent and delete cascades', async () => {
    const create = await request(app.getHttpServer())
      .post(`${base()}/sources`)
      .set(auth())
      .send({
        type: 'manual',
        name: 'temp',
        config: { title: 'T', body: 'alpha beta gamma' },
      })
      .expect(201);
    const sourceId = (create.body as SourceBody).id;

    const before = await request(app.getHttpServer())
      .get(`${base()}/documents?sourceId=${sourceId}`)
      .set(auth())
      .expect(200);
    const beforeId = (before.body as DocListItem[])[0].id;

    await request(app.getHttpServer())
      .post(`${base()}/sources/${sourceId}/reprocess`)
      .set(auth())
      .expect(201);
    const afterReprocess = await request(app.getHttpServer())
      .get(`${base()}/documents?sourceId=${sourceId}`)
      .set(auth())
      .expect(200);
    const afterList = afterReprocess.body as DocListItem[];
    expect(afterList).toHaveLength(1);
    // Change detection: unchanged content is not re-inserted, so the document
    // row (and its id) is preserved rather than deleted + recreated.
    expect(afterList[0].id).toBe(beforeId);

    await request(app.getHttpServer())
      .delete(`${base()}/sources/${sourceId}`)
      .set(auth())
      .expect(200);
    await request(app.getHttpServer())
      .get(`${base()}/sources/${sourceId}`)
      .set(auth())
      .expect(404);
    const docsGone = await request(app.getHttpServer())
      .get(`${base()}/documents?sourceId=${sourceId}`)
      .set(auth())
      .expect(200);
    expect(docsGone.body as DocListItem[]).toHaveLength(0);
  });

  it('crawl-now re-ingests a source (roadmap #19)', async () => {
    const create = await request(app.getHttpServer())
      .post(`${base()}/sources`)
      .set(auth())
      .send({
        type: 'manual',
        name: 'crawlme',
        config: { title: 'C', body: 'een twee drie vier vijf' },
      })
      .expect(201);
    const sourceId = (create.body as SourceBody).id;

    const res = await request(app.getHttpServer())
      .post(`${base()}/sources/${sourceId}/crawl`)
      .set(auth())
      .expect(201);
    expect((res.body as SourceBody).status).toBe('processed');
  });

  it('sets and clears a per-source re-crawl schedule (roadmap #19)', async () => {
    const create = await request(app.getHttpServer())
      .post(`${base()}/sources`)
      .set(auth())
      .send({
        type: 'manual',
        name: 'sched',
        config: { title: 'S', body: 'alfa bravo charlie' },
      })
      .expect(201);
    const sourceId = (create.body as SourceBody).id;

    // Too-tight interval is rejected.
    await request(app.getHttpServer())
      .put(`${base()}/sources/${sourceId}/schedule`)
      .set(auth())
      .send({ recrawlIntervalMs: 1000 })
      .expect(400);

    const set = await request(app.getHttpServer())
      .put(`${base()}/sources/${sourceId}/schedule`)
      .set(auth())
      .send({ recrawlIntervalMs: 3_600_000 })
      .expect(200);
    expect((set.body as SourceBody).recrawlIntervalMs).toBe(3_600_000);

    const cleared = await request(app.getHttpServer())
      .put(`${base()}/sources/${sourceId}/schedule`)
      .set(auth())
      .send({ recrawlIntervalMs: null })
      .expect(200);
    expect((cleared.body as SourceBody).recrawlIntervalMs).toBeNull();
  });

  it('reports source health overview with counts (roadmap #20)', async () => {
    const create = await request(app.getHttpServer())
      .post(`${base()}/sources`)
      .set(auth())
      .send({
        type: 'manual',
        name: 'health',
        config: { title: 'H', body: 'delta echo foxtrot golf hotel' },
      })
      .expect(201);
    const sourceId = (create.body as SourceBody).id;

    const health = await request(app.getHttpServer())
      .get(`${base()}/sources/health`)
      .set(auth())
      .expect(200);
    const rows = health.body as HealthRow[];
    const row = rows.find((r) => r.id === sourceId);
    expect(row).toBeDefined();
    expect(row?.status).toBe('processed');
    expect(row?.documentCount).toBeGreaterThan(0);
    expect(row?.chunkCount).toBeGreaterThan(0);
    expect(row?.failedDocumentCount).toBe(0);
  });

  it('toggles a document enabled/disabled (#21) without deleting it', async () => {
    const create = await request(app.getHttpServer())
      .post(`${base()}/sources`)
      .set(auth())
      .send({
        type: 'manual',
        name: 'toggle',
        config: { title: 'Toggle', body: 'een twee drie vier vijf' },
      })
      .expect(201);
    const sourceId = (create.body as SourceBody).id;

    const list = await request(app.getHttpServer())
      .get(`${base()}/documents?sourceId=${sourceId}`)
      .set(auth())
      .expect(200);
    const doc = (list.body as DocListItem[])[0];
    // New documents default to enabled.
    expect(doc.enabled).toBe(true);

    // Disable it.
    const disabled = await request(app.getHttpServer())
      .patch(`${base()}/documents/${doc.id}`)
      .set(auth())
      .send({ enabled: false })
      .expect(200);
    expect((disabled.body as DocBody).enabled).toBe(false);

    // Reflected in list + detail; chunks are preserved (not deleted).
    const afterList = await request(app.getHttpServer())
      .get(`${base()}/documents?sourceId=${sourceId}`)
      .set(auth())
      .expect(200);
    const afterDoc = (afterList.body as DocListItem[])[0];
    expect(afterDoc.enabled).toBe(false);
    expect(afterDoc.chunkCount).toBeGreaterThan(0);

    // Re-enable.
    const enabled = await request(app.getHttpServer())
      .patch(`${base()}/documents/${doc.id}`)
      .set(auth())
      .send({ enabled: true })
      .expect(200);
    expect((enabled.body as DocBody).enabled).toBe(true);
  });

  it('rejects a non-boolean enabled value (#21)', async () => {
    const create = await request(app.getHttpServer())
      .post(`${base()}/sources`)
      .set(auth())
      .send({
        type: 'manual',
        name: 'toggle-bad',
        config: { title: 'ToggleBad', body: 'alpha beta gamma delta' },
      })
      .expect(201);
    const sourceId = (create.body as SourceBody).id;
    const list = await request(app.getHttpServer())
      .get(`${base()}/documents?sourceId=${sourceId}`)
      .set(auth())
      .expect(200);
    const doc = (list.body as DocListItem[])[0];

    await request(app.getHttpServer())
      .patch(`${base()}/documents/${doc.id}`)
      .set(auth())
      .send({ enabled: 'nope' })
      .expect(400);
  });

  it('returns 404 when toggling an unknown document (#21)', async () => {
    await request(app.getHttpServer())
      .patch(`${base()}/documents/00000000-0000-0000-0000-000000000000`)
      .set(auth())
      .send({ enabled: false })
      .expect(404);
  });
});
