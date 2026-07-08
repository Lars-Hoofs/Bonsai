import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
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
interface DocListItem {
  id: string;
  title: string;
  chunkCount: number;
}

describe('knowledge upload + website scrape e2e', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let idp: TestIdp;
  let token: string;
  let tenantId: string;
  let projectId: string;
  let site: Server;
  let siteUrl: string;

  const base = (): string =>
    `/v1/tenants/${tenantId}/projects/${projectId}/knowledge`;
  const auth = (): { Authorization: string } => ({
    Authorization: `Bearer ${token}`,
  });

  beforeAll(async () => {
    site = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        '<html><head><title>Openingstijden</title></head><body>' +
          '<h1>Openingstijden</h1><p>Onze winkel is maandag tot vrijdag open van negen tot vijf.</p>' +
          '<script>track()</script></body></html>',
      );
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;

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
    await new Promise<void>((r) => site.close(() => r()));
  });

  it('ingests an uploaded text file', async () => {
    const res = await request(app.getHttpServer())
      .post(`${base()}/sources/upload`)
      .set(auth())
      .attach('file', Buffer.from('Retourneren kan binnen dertig dagen.'), {
        filename: 'retour.txt',
        contentType: 'text/plain',
      })
      .expect(201);
    expect((res.body as { status: string }).status).toBe('processed');

    const docs = await request(app.getHttpServer())
      .get(`${base()}/documents?sourceId=${(res.body as IdBody).id}`)
      .set(auth())
      .expect(200);
    const list = docs.body as DocListItem[];
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe('retour.txt');
    expect(list[0].chunkCount).toBeGreaterThan(0);
  });

  it('scrapes a website source into text (tags/scripts stripped)', async () => {
    const res = await request(app.getHttpServer())
      .post(`${base()}/sources`)
      .set(auth())
      .send({ type: 'website', name: 'Site', config: { url: siteUrl } })
      .expect(201);
    expect((res.body as { status: string }).status).toBe('processed');

    const docs = await request(app.getHttpServer())
      .get(`${base()}/documents?sourceId=${(res.body as IdBody).id}`)
      .set(auth())
      .expect(200);
    const list = docs.body as DocListItem[];
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe('Openingstijden');

    const doc = await request(app.getHttpServer())
      .get(`${base()}/documents/${list[0].id}`)
      .set(auth())
      .expect(200);
    const body = doc.body as { chunks: { text: string }[] };
    const allText = body.chunks.map((c) => c.text).join(' ');
    expect(allText).toContain('maandag tot vrijdag');
    expect(allText).not.toContain('track()');
  });
});
