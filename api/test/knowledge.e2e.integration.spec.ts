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
}
interface DocListItem {
  id: string;
  title: string;
  chunkCount: number;
}
interface DocBody {
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
});
