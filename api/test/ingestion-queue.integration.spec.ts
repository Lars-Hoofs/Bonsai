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
import { IngestionQueueService } from '../src/knowledge/ingestion/ingestion-queue.service';
import { runControlPlaneMigrations } from '../src/db/run-control-plane-migrations';
import * as schema from '../src/db/schema';
import { startPg } from './helpers/pg';

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

describe('IngestionQueueService (async background ingestion via BullMQ)', () => {
  let pgc: StartedPostgreSqlContainer;
  let pool: Pool;
  let redis: StartedRedisContainer;
  let queue: IngestionQueueService;
  let tenantDb: TenantDbService;
  let schemaName: string;

  beforeAll(async () => {
    ({ container: pgc, pool } = await startPg());
    await runControlPlaneMigrations(pool);
    redis = await new RedisContainer('redis:7-alpine').start();

    const prov = new TenantProvisioningService(pool, drizzle(pool, { schema }));
    ({ schemaName } = await prov.createTenant({ name: 'Q', slug: 'q' }));
    tenantDb = new TenantDbService(pool);

    const ingestion = new IngestionService(
      tenantDb,
      new ChunkingService(),
      new FakeEmbeddingProvider(1024),
    );
    queue = new IngestionQueueService(ingestion);
    queue.start(redis.getConnectionUrl());
  }, 180000);

  afterAll(async () => {
    await queue?.onModuleDestroy();
    if (redis) await redis.stop();
    if (pool) await pool.end();
    if (pgc) await pgc.stop();
  });

  it('is enabled once started against Redis', () => {
    expect(queue.isEnabled()).toBe(true);
  });

  it('enqueues a source and the worker ingests it in the background', async () => {
    const sourceId = await tenantDb.withTenant(schemaName, async (db) => {
      const p = await db.execute(
        sql`INSERT INTO projects (name) VALUES ('Bot') RETURNING id`,
      );
      const projectId = (p.rows[0] as { id: string }).id;
      const s = await db.execute(
        sql`INSERT INTO knowledge_sources (project_id, type, name, config, status)
          VALUES (${projectId}, 'manual', 'Doc',
            ${JSON.stringify({ title: 'Doc', body: 'De winkel is op maandag geopend.', language: 'nl' })}::jsonb,
            'pending') RETURNING id`,
      );
      return (s.rows[0] as { id: string }).id;
    });

    // Enqueue returns immediately; the worker processes it asynchronously.
    await queue.enqueue(schemaName, sourceId);

    // Poll until the background worker has ingested it (status -> processed).
    let status = 'pending';
    for (let i = 0; i < 40; i++) {
      status = await tenantDb.withTenant(schemaName, async (db) => {
        const r = await db.execute(
          sql`SELECT status FROM knowledge_sources WHERE id=${sourceId}`,
        );
        return (r.rows[0] as { status: string }).status;
      });
      if (status === 'processed') break;
      await sleep(250);
    }
    expect(status).toBe('processed');

    // And the document/chunks were actually produced by the background run.
    const chunkCount = await tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`SELECT count(*)::int AS n FROM chunks c
            JOIN documents d ON d.id = c.document_id
            JOIN knowledge_sources s ON s.id = d.source_id
            WHERE s.id = ${sourceId}`,
      );
      return (r.rows[0] as { n: number }).n;
    });
    expect(chunkCount).toBeGreaterThan(0);
  }, 60000);
});
