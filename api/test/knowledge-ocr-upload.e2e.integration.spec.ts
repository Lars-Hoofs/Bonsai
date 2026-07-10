import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPg } from './helpers/pg';
import { buildTestApp } from './helpers/app';
import { TestIdp } from './helpers/oidc';
import type { OcrProvider } from '../src/knowledge/ingestion/ocr-provider';

interface IdBody {
  id: string;
  status: string;
}
interface DocListItem {
  id: string;
  title: string;
  chunkCount: number;
}
interface DocBody {
  chunks: { text: string }[];
}

// A tiny fake PNG — its bytes are irrelevant since normal "extraction" for
// images never reads them (extractUploadText has no native image text path);
// what matters is the OCR seam being stubbed to return canned text.
const FAKE_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

/**
 * Each scenario needs its own app instance built with a differently
 * configured/stubbed OCR provider (OCR_ENABLED true/false, or a plain app
 * with no override at all) — and `app.close()` tears down the shared `Pool`
 * (DbModule.onApplicationShutdown), so each gets its own Testcontainers
 * Postgres too, matching the pattern other multi-scenario e2e specs use when
 * they need distinct app configs.
 */
async function setupTenant(
  app: INestApplication,
  idp: TestIdp,
): Promise<{ token: string; tenantId: string; projectId: string }> {
  const token = await idp.sign({ sub: 'oidc|u1', email: 'u1@acme.eu' });
  const auth = { Authorization: `Bearer ${token}` };
  const t = await request(app.getHttpServer())
    .post('/v1/tenants')
    .set(auth)
    .send({
      name: 'Acme',
      slug: `acme-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    })
    .expect(201);
  const tenantId = (t.body as IdBody).id;
  const p = await request(app.getHttpServer())
    .post(`/v1/tenants/${tenantId}/projects`)
    .set(auth)
    .send({ name: 'Bot' })
    .expect(201);
  const projectId = (p.body as IdBody).id;
  return { token, tenantId, projectId };
}

const base = (tenantId: string, projectId: string): string =>
  `/v1/tenants/${tenantId}/projects/${projectId}/knowledge`;

describe('knowledge OCR upload fallback e2e (#24): OCR enabled', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let idp: TestIdp;
  const recognize = jest.fn().mockResolvedValue('Gescande tekst');
  const ocrProvider: OcrProvider = { recognize };

  beforeAll(async () => {
    ({ container, pool } = await startPg());
    ({ app, idp } = await buildTestApp(
      pool,
      { ocrEnabled: true },
      ocrProvider,
    ));
  }, 120000);

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('OCRs an image upload whose normal extraction is empty, using the stubbed OCR text', async () => {
    const { token, tenantId, projectId } = await setupTenant(app, idp);
    const auth = { Authorization: `Bearer ${token}` };

    const res = await request(app.getHttpServer())
      .post(`${base(tenantId, projectId)}/sources/upload`)
      .set(auth)
      .attach('file', FAKE_PNG, {
        filename: 'scan.png',
        contentType: 'image/png',
      })
      .expect(201);
    expect((res.body as IdBody).status).toBe('processed');

    const docs = await request(app.getHttpServer())
      .get(
        `${base(tenantId, projectId)}/documents?sourceId=${(res.body as IdBody).id}`,
      )
      .set(auth)
      .expect(200);
    const list = docs.body as DocListItem[];
    expect(list).toHaveLength(1);
    expect(list[0].chunkCount).toBeGreaterThan(0);

    const doc = await request(app.getHttpServer())
      .get(`${base(tenantId, projectId)}/documents/${list[0].id}`)
      .set(auth)
      .expect(200);
    const allText = (doc.body as DocBody).chunks.map((c) => c.text).join(' ');
    expect(allText).toContain('Gescande tekst');
    expect(recognize).toHaveBeenCalledTimes(1);
  });

  it('never triggers OCR for a normal text-bearing upload', async () => {
    recognize.mockClear();
    const { token, tenantId, projectId } = await setupTenant(app, idp);
    const auth = { Authorization: `Bearer ${token}` };

    await request(app.getHttpServer())
      .post(`${base(tenantId, projectId)}/sources/upload`)
      .set(auth)
      .attach('file', Buffer.from('Retourneren kan binnen dertig dagen.'), {
        filename: 'retour.txt',
        contentType: 'text/plain',
      })
      .expect(201);

    expect(recognize).not.toHaveBeenCalled();
  });
});

describe('knowledge OCR upload fallback e2e (#24): OCR disabled', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let idp: TestIdp;
  const recognize = jest.fn().mockResolvedValue('Gescande tekst');
  const ocrProvider: OcrProvider = { recognize };

  beforeAll(async () => {
    ({ container, pool } = await startPg());
    ({ app, idp } = await buildTestApp(
      pool,
      { ocrEnabled: false },
      ocrProvider,
    ));
  }, 120000);

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('does not run OCR when OCR_ENABLED is false, even for an image upload', async () => {
    const { token, tenantId, projectId } = await setupTenant(app, idp);
    const auth = { Authorization: `Bearer ${token}` };

    const res = await request(app.getHttpServer())
      .post(`${base(tenantId, projectId)}/sources/upload`)
      .set(auth)
      .attach('file', FAKE_PNG, {
        filename: 'scan.png',
        contentType: 'image/png',
      })
      .expect(201);
    expect((res.body as IdBody).status).toBe('processed');

    const docs = await request(app.getHttpServer())
      .get(
        `${base(tenantId, projectId)}/documents?sourceId=${(res.body as IdBody).id}`,
      )
      .set(auth)
      .expect(200);
    const list = docs.body as DocListItem[];
    expect(list).toHaveLength(1);
    // No native text, no OCR -> zero chunks.
    expect(list[0].chunkCount).toBe(0);
    expect(recognize).not.toHaveBeenCalled();
  });
});
