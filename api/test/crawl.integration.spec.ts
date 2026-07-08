import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { TenantProvisioningService } from '../src/tenancy/tenant-provisioning.service';
import { TenantDbService } from '../src/tenancy/tenant-db.service';
import { ChunkingService } from '../src/knowledge/chunking/chunking.service';
import { FakeEmbeddingProvider } from '../src/knowledge/embedding/fake-embedding.provider';
import { IngestionService } from '../src/knowledge/ingestion/ingestion.service';
import { CrawlService } from '../src/crawl/crawl.service';
import { runControlPlaneMigrations } from '../src/db/run-control-plane-migrations';
import * as schema from '../src/db/schema';
import { startPg } from './helpers/pg';

describe('scheduled re-crawl (BullMQ)', () => {
  let pgc: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let pool: Pool;
  let tenantDb: TenantDbService;
  let crawl: CrawlService;
  let site: Server;
  let siteUrl: string;
  let schemaName: string;
  let sourceId: string;
  const projectId = randomHex();

  function randomHex(): string {
    // Deterministic-enough project id for the test (no crypto import needed).
    return '00000000-0000-4000-8000-000000000abc';
  }

  beforeAll(async () => {
    site = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        '<html><head><title>Site</title></head><body><p>Verse inhoud van de pagina.</p></body></html>',
      );
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;

    ({ container: pgc, pool } = await startPg());
    redis = await new RedisContainer('redis:7-alpine').start();
    await runControlPlaneMigrations(pool);
    const prov = new TenantProvisioningService(pool, drizzle(pool, { schema }));
    ({ schemaName } = await prov.createTenant({ name: 'C', slug: 'c' }));
    tenantDb = new TenantDbService(pool);

    sourceId = await tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`INSERT INTO knowledge_sources (project_id, type, name, config, status)
            VALUES (${projectId}, 'website', 'Site', ${JSON.stringify({ url: siteUrl })}::jsonb, 'pending')
            RETURNING id`,
      );
      return (r.rows[0] as { id: string }).id;
    });

    const ingestion = new IngestionService(
      tenantDb,
      new ChunkingService(),
      new FakeEmbeddingProvider(1024),
    );
    crawl = new CrawlService(
      redis.getConnectionUrl(),
      pool,
      tenantDb,
      ingestion,
    );
    crawl.start();
  }, 180000);

  afterAll(async () => {
    await crawl.close();
    await pool.end();
    await pgc.stop();
    await redis.stop();
    await new Promise<void>((r) => site.close(() => r()));
  });

  it('scans website sources and the worker re-ingests them', async () => {
    const enqueued = await crawl.scanAndEnqueueAll();
    expect(enqueued).toBe(1);

    // Wait for the worker to process the source into 'processed'.
    await waitFor(async () => {
      const r = await tenantDb.withTenant(schemaName, (db) =>
        db.execute(
          sql`SELECT status FROM knowledge_sources WHERE id = ${sourceId}`,
        ),
      );
      return (r.rows[0] as { status: string }).status === 'processed';
    }, 15000);

    const docs = await tenantDb.withTenant(schemaName, (db) =>
      db.execute(
        sql`SELECT count(*)::int AS c FROM documents WHERE source_id = ${sourceId}`,
      ),
    );
    expect((docs.rows[0] as { c: number }).c).toBe(1);
  });
});

async function waitFor(
  cond: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Condition not met within timeout');
}
