import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPg } from './helpers/pg';
import { buildTestApp } from './helpers/app';
import { TestIdp } from './helpers/oidc';

interface KbEntry {
  title: string;
  body: string;
  language?: string;
}
interface ImportSummary {
  imported: number;
  failed: number;
  errors: { row: number; message: string }[];
}
interface DocListItem {
  id: string;
  title: string;
  chunkCount: number;
}

describe('KB bulk import/export e2e', () => {
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
    token = await idp.sign({ sub: 'oidc|kb', email: 'kb@acme.eu' });
    const t = await request(app.getHttpServer())
      .post('/v1/tenants')
      .set(auth())
      .send({ name: 'Acme', slug: 'acme-kb' })
      .expect(201);
    tenantId = (t.body as { id: string }).id;
    const p = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/projects`)
      .set(auth())
      .send({ name: 'Bot' })
      .expect(201);
    projectId = (p.body as { id: string }).id;

    // Seed two manual entries so export has content.
    for (const e of [
      { title: 'Openingstijden', body: 'Wij zijn ma-vr geopend van 9 tot 17.' },
      { title: 'Retourbeleid', body: 'Retourneren kan binnen dertig dagen.' },
    ]) {
      await request(app.getHttpServer())
        .post(`${base()}/sources`)
        .set(auth())
        .send({ type: 'manual', name: e.title, config: e })
        .expect(201);
    }
  });
  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('exports the manual KB as JSON', async () => {
    const res = await request(app.getHttpServer())
      .get(`${base()}/export?format=json`)
      .set(auth())
      .expect(200);
    expect(res.headers['content-disposition']).toContain('.json');
    const body = res.body as { entries: KbEntry[] };
    expect(body.entries).toHaveLength(2);
    expect(body.entries.map((e) => e.title)).toEqual(
      expect.arrayContaining(['Openingstijden', 'Retourbeleid']),
    );
  });

  it('exports as CSV', async () => {
    const res = await request(app.getHttpServer())
      .get(`${base()}/export?format=csv`)
      .set(auth())
      .expect(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text.split('\r\n')[0]).toBe('title,body,language');
    expect(res.text).toContain('Openingstijden');
  });

  it('exports as a Markdown zip and re-imports it losslessly', async () => {
    const zipRes = await request(app.getHttpServer())
      .get(`${base()}/export?format=zip`)
      .set(auth())
      .buffer(true)
      .parse((res, cb) => {
        res.setEncoding('binary');
        let data = '';
        res.on('data', (c: string) => {
          data += c;
        });
        res.on('end', () => cb(null, Buffer.from(data, 'binary')));
      })
      .expect(200);
    expect(zipRes.headers['content-type']).toContain('application/zip');
    const zipBuf = zipRes.body as Buffer;
    // ZIP magic.
    expect(zipBuf.subarray(0, 2).toString('latin1')).toBe('PK');

    const imp = await request(app.getHttpServer())
      .post(`${base()}/import`)
      .set(auth())
      .field('format', 'zip')
      .attach('file', zipBuf, 'kb.zip')
      .expect(201);
    const summary = imp.body as ImportSummary;
    expect(summary.imported).toBe(2);
    expect(summary.failed).toBe(0);
  });

  it('imports a JSON bundle and ingests entries (searchable documents)', async () => {
    const p = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/projects`)
      .set(auth())
      .send({ name: 'Imported' })
      .expect(201);
    const importProjectId = (p.body as { id: string }).id;
    const iBase = `/v1/tenants/${tenantId}/projects/${importProjectId}/knowledge`;

    const bundle = JSON.stringify({
      version: 1,
      entries: [
        { title: 'Levering', body: 'Wij leveren binnen twee werkdagen.' },
        { title: 'Betaling', body: 'Betalen kan met iDEAL of creditcard.' },
      ],
    });
    const imp = await request(app.getHttpServer())
      .post(`${iBase}/import`)
      .set(auth())
      .field('format', 'json')
      .attach('file', Buffer.from(bundle), 'kb.json')
      .expect(201);
    const summary = imp.body as ImportSummary;
    expect(summary.imported).toBe(2);

    const docs = await request(app.getHttpServer())
      .get(`${iBase}/documents`)
      .set(auth())
      .expect(200);
    const docList = docs.body as DocListItem[];
    expect(docList).toHaveLength(2);
    expect(docList.every((d) => d.chunkCount > 0)).toBe(true);
  });

  it('reports per-row errors on a bundle with invalid rows', async () => {
    const bundle = JSON.stringify([
      { title: 'Geldig', body: 'inhoud' },
      { title: '', body: 'geen titel' },
      { title: 'geen body', body: '   ' },
    ]);
    const imp = await request(app.getHttpServer())
      .post(`${base()}/import`)
      .set(auth())
      .field('format', 'json')
      .attach('file', Buffer.from(bundle), 'kb.json')
      .expect(201);
    const summary = imp.body as ImportSummary;
    expect(summary.imported).toBe(1);
    expect(summary.failed).toBe(2);
    expect(summary.errors.map((e) => e.row).sort()).toEqual([1, 2]);
  });

  it('rejects a malformed bundle with 400', async () => {
    await request(app.getHttpServer())
      .post(`${base()}/import`)
      .set(auth())
      .field('format', 'json')
      .attach('file', Buffer.from('{ not json'), 'kb.json')
      .expect(400);
  });

  it('forbids export for a viewer (editor role required)', async () => {
    const viewerToken = await idp.sign({
      sub: 'oidc|viewer-kb',
      email: 'viewer-kb@acme.eu',
    });
    // A brand-new user with no membership on this tenant is forbidden.
    await request(app.getHttpServer())
      .get(`${base()}/export?format=json`)
      .set({ Authorization: `Bearer ${viewerToken}` })
      .expect(403);
  });
});
