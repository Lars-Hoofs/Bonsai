import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { TenantProvisioningService } from '../src/tenancy/tenant-provisioning.service';
import { TenantDbService } from '../src/tenancy/tenant-db.service';
import { ChunkingService } from '../src/knowledge/chunking/chunking.service';
import { FakeEmbeddingProvider } from '../src/knowledge/embedding/fake-embedding.provider';
import { IngestionService } from '../src/knowledge/ingestion/ingestion.service';
import { runControlPlaneMigrations } from '../src/db/run-control-plane-migrations';
import * as schema from '../src/db/schema';
import { startPg } from './helpers/pg';
import * as safeFetchModule from '../src/common/safe-fetch';

/**
 * Multi-page website crawl + per-page change detection (#14).
 *
 * `safeFetch` is stubbed to serve from an in-memory url->html map rather than
 * hitting the network — `crawlSite`'s default page-fetcher wraps `safeFetch`,
 * so stubbing it here exercises the exact same code path `IngestionService`
 * uses in production (unlike injecting a fetchPage stub directly into
 * `crawlSite`, which would bypass `IngestionService`'s own wiring).
 */
let pageMap: Record<string, string> = {};

jest
  .spyOn(safeFetchModule, 'safeFetch')
  .mockImplementation((rawUrl: string) => {
    const body = pageMap[rawUrl];
    if (body === undefined) {
      return Promise.resolve({
        status: 404,
        body: 'not found',
        finalUrl: rawUrl,
      });
    }
    return Promise.resolve({ status: 200, body, finalUrl: rawUrl });
  });

function page(title: string, links: string[] = [], text = ''): string {
  return (
    `<html><head><title>${title}</title></head><body>` +
    links.map((l) => `<a href="${l}">link</a>`).join('') +
    `<p>${text || `Body of ${title}`}</p></body></html>`
  );
}

function sitemap(urls: string[]): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
    urls.map((u) => `<url><loc>${u}</loc></url>`).join('') +
    `</urlset>`
  );
}

interface DocRow {
  id: string;
  origin_url: string | null;
  title: string;
  content_hash: string;
}

describe('multi-page site crawl + per-page change detection', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let tenantDb: TenantDbService;
  let ingestion: IngestionService;
  let schemaName: string;
  const projectId = randomUUID();
  const origin = 'https://crawlsite.example';

  beforeAll(async () => {
    ({ container, pool } = await startPg());
    await runControlPlaneMigrations(pool);
    const prov = new TenantProvisioningService(pool, drizzle(pool, { schema }));
    ({ schemaName } = await prov.createTenant({
      name: 'Crawl',
      slug: 'crawl',
    }));
    tenantDb = new TenantDbService(pool);
    ingestion = new IngestionService(
      tenantDb,
      new ChunkingService(),
      new FakeEmbeddingProvider(1024),
    );
  }, 180000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  beforeEach(() => {
    pageMap = {};
  });

  async function insertWebsiteSource(
    config: Record<string, unknown>,
  ): Promise<string> {
    return tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`INSERT INTO knowledge_sources (project_id, type, name, config, status)
            VALUES (${projectId}, 'website', 'Site', ${JSON.stringify(config)}::jsonb, 'pending')
            RETURNING id`,
      );
      return (r.rows[0] as { id: string }).id;
    });
  }

  async function getDocs(sourceId: string): Promise<DocRow[]> {
    const r = await tenantDb.withTenant(schemaName, (db) =>
      db.execute(
        sql`SELECT id, origin_url, title, content_hash FROM documents WHERE source_id=${sourceId} ORDER BY origin_url`,
      ),
    );
    return r.rows as DocRow[];
  }

  async function chunkCount(documentId: string): Promise<number> {
    const r = await tenantDb.withTenant(schemaName, (db) =>
      db.execute(
        sql`SELECT count(*)::int AS c FROM chunks WHERE document_id=${documentId}`,
      ),
    );
    return (r.rows[0] as { c: number }).c;
  }

  async function firstChunkId(documentId: string): Promise<string> {
    const r = await tenantDb.withTenant(schemaName, (db) =>
      db.execute(
        sql`SELECT id FROM chunks WHERE document_id=${documentId} ORDER BY ordinal LIMIT 1`,
      ),
    );
    return (r.rows[0] as { id: string }).id;
  }

  it('crawls a sitemap-listed site into one document per page', async () => {
    const urls = [`${origin}/a`, `${origin}/b`, `${origin}/c`];
    pageMap = {
      [`${origin}/sitemap.xml`]: sitemap(urls),
      [`${origin}/a`]: page('A', [], 'Content of page A.'),
      [`${origin}/b`]: page('B', [], 'Content of page B.'),
      [`${origin}/c`]: page('C', [], 'Content of page C.'),
    };

    const sourceId = await insertWebsiteSource({
      url: `${origin}/`,
      crawl: true,
      maxPages: 10,
      maxDepth: 2,
    });
    await ingestion.ingestSource(schemaName, sourceId);

    const docs = await getDocs(sourceId);
    expect(docs).toHaveLength(3);
    expect(docs.map((d) => d.origin_url).sort()).toEqual(urls.sort());
    for (const doc of docs) {
      expect(await chunkCount(doc.id)).toBeGreaterThan(0);
    }
    const titles = docs.map((d) => d.title).sort();
    expect(titles).toEqual(['A', 'B', 'C']);
  });

  it('on re-crawl, only re-embeds changed/new pages and removes gone pages', async () => {
    const urlA = `${origin}/a`;
    const urlB = `${origin}/b`;
    const urlC = `${origin}/c`;
    pageMap = {
      [`${origin}/sitemap.xml`]: sitemap([urlA, urlB, urlC]),
      [urlA]: page('A', [], 'Original content of page A.'),
      [urlB]: page('B', [], 'Original content of page B.'),
      [urlC]: page('C', [], 'Original content of page C.'),
    };

    const sourceId = await insertWebsiteSource({
      url: `${origin}/`,
      crawl: true,
      maxPages: 10,
      maxDepth: 2,
    });
    await ingestion.ingestSource(schemaName, sourceId);

    const before = await getDocs(sourceId);
    const beforeByUrl = new Map(before.map((d) => [d.origin_url, d]));
    const docA = beforeByUrl.get(urlA)!;
    const docB = beforeByUrl.get(urlB)!;
    const docC = beforeByUrl.get(urlC)!;
    const bStableChunkId = await firstChunkId(docB.id);

    // Re-crawl: A's content changes, B stays identical, C is removed, D is added.
    const urlD = `${origin}/d`;
    pageMap = {
      [`${origin}/sitemap.xml`]: sitemap([urlA, urlB, urlD]),
      [urlA]: page('A', [], 'CHANGED content of page A.'),
      [urlB]: page('B', [], 'Original content of page B.'),
      [urlD]: page('D', [], 'Brand-new content of page D.'),
    };
    await ingestion.ingestSource(schemaName, sourceId);

    const after = await getDocs(sourceId);
    expect(after).toHaveLength(3);
    const afterByUrl = new Map(after.map((d) => [d.origin_url, d]));

    // A: same document id, but content_hash changed (re-embedded).
    const afterA = afterByUrl.get(urlA)!;
    expect(afterA.id).toBe(docA.id);
    expect(afterA.content_hash).not.toBe(docA.content_hash);

    // B: fully untouched — same document id, same content_hash, and its
    // chunk row was never deleted/recreated (stable chunk id).
    const afterB = afterByUrl.get(urlB)!;
    expect(afterB.id).toBe(docB.id);
    expect(afterB.content_hash).toBe(docB.content_hash);
    expect(await firstChunkId(afterB.id)).toBe(bStableChunkId);

    // C: gone.
    expect(afterByUrl.has(urlC)).toBe(false);
    const cGone = await tenantDb.withTenant(schemaName, (db) =>
      db.execute(sql`SELECT id FROM documents WHERE id=${docC.id}`),
    );
    expect(cGone.rows).toHaveLength(0);

    // D: newly added.
    const afterD = afterByUrl.get(urlD)!;
    expect(afterD.title).toBe('D');
    expect(await chunkCount(afterD.id)).toBeGreaterThan(0);
  });

  it('falls back to same-origin link-crawling when there is no sitemap, respecting maxPages/maxDepth', async () => {
    const home = `${origin}/`;
    const p1 = `${origin}/page1`;
    const p2 = `${origin}/page2`;
    const external = 'https://external.example/other';
    pageMap = {
      // No sitemap.xml entry -> safeFetch stub returns 404 for it, triggering
      // the link-crawl fallback in crawlSite.
      [home]: page('Home', [p1, p2, external]),
      [p1]: page('Page1'),
      [p2]: page('Page2'),
      [external]: page('External'),
    };

    const sourceId = await insertWebsiteSource({
      url: home,
      crawl: true,
      maxPages: 10,
      maxDepth: 2,
    });
    await ingestion.ingestSource(schemaName, sourceId);

    const docs = await getDocs(sourceId);
    const urls = docs.map((d) => d.origin_url).sort();
    expect(urls).toEqual([home, p1, p2].sort());
    expect(urls).not.toContain(external);
  });

  it('respects maxPages in link-crawl fallback mode', async () => {
    const home = `${origin}/`;
    const p1 = `${origin}/page1`;
    const p2 = `${origin}/page2`;
    const p3 = `${origin}/page3`;
    pageMap = {
      [home]: page('Home', [p1, p2, p3]),
      [p1]: page('Page1'),
      [p2]: page('Page2'),
      [p3]: page('Page3'),
    };

    const sourceId = await insertWebsiteSource({
      url: home,
      crawl: true,
      maxPages: 2,
      maxDepth: 2,
    });
    await ingestion.ingestSource(schemaName, sourceId);

    const docs = await getDocs(sourceId);
    expect(docs).toHaveLength(2);
  });

  it('single-page website (no crawl flag) behaves exactly as before', async () => {
    const url = `${origin}/single`;
    pageMap = { [url]: page('Single', [], 'Just one page.') };

    const sourceId = await insertWebsiteSource({ url });
    await ingestion.ingestSource(schemaName, sourceId);

    const docs = await getDocs(sourceId);
    expect(docs).toHaveLength(1);
    expect(docs[0].origin_url).toBe(url);
    expect(docs[0].title).toBe('Single');

    // Re-ingest unchanged -> document id preserved (existing whole-source
    // short-circuit, now also true via the per-page upsert path).
    await ingestion.ingestSource(schemaName, sourceId);
    const after = await getDocs(sourceId);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(docs[0].id);
  });
});
