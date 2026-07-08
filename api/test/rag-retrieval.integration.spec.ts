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
import { RetrievalService } from '../src/rag/retrieval.service';
import { runControlPlaneMigrations } from '../src/db/run-control-plane-migrations';
import * as schema from '../src/db/schema';
import { startPg } from './helpers/pg';

describe('RAG hybrid retrieval', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let tenantDb: TenantDbService;
  let ingestion: IngestionService;
  let retrieval: RetrievalService;
  let schemaName: string;
  const projectId = randomUUID();

  const addManual = async (title: string, body: string): Promise<void> => {
    const id = await tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`INSERT INTO knowledge_sources (project_id, type, name, config, status)
            VALUES (${projectId}, 'manual', ${title},
                    ${JSON.stringify({ title, body, language: 'nl' })}::jsonb, 'pending')
            RETURNING id`,
      );
      return (r.rows[0] as { id: string }).id;
    });
    await ingestion.ingestSource(schemaName, id);
  };

  beforeAll(async () => {
    ({ container, pool } = await startPg());
    await runControlPlaneMigrations(pool);
    const prov = new TenantProvisioningService(pool, drizzle(pool, { schema }));
    ({ schemaName } = await prov.createTenant({ name: 'R', slug: 'r' }));
    const embedder = new FakeEmbeddingProvider(1024);
    tenantDb = new TenantDbService(pool);
    ingestion = new IngestionService(tenantDb, new ChunkingService(), embedder);
    retrieval = new RetrievalService(tenantDb, embedder);

    await addManual(
      'Openingstijden',
      'De openingstijden van onze winkel zijn maandag tot en met vrijdag van negen tot vijf uur.',
    );
    await addManual(
      'Retourneren',
      'Retourneren van een product kan binnen dertig dagen met de originele kassabon.',
    );
    await addManual(
      'Bezorging',
      'Wij bezorgen gratis bij alle bestellingen boven de vijftig euro binnen Nederland.',
    );
  }, 120000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  it('ranks the relevant chunk first for a semantic + lexical query', async () => {
    const results = await retrieval.retrieve(
      schemaName,
      projectId,
      'wat zijn de openingstijden van de winkel',
    );
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].text).toContain('openingstijden');
    expect(results[0].documentTitle).toBe('Openingstijden');
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('retrieves the retour chunk for a return question', async () => {
    const results = await retrieval.retrieve(
      schemaName,
      projectId,
      'kan ik iets retourneren',
    );
    expect(results[0].text.toLowerCase()).toContain('retourneren');
  });

  it('scopes retrieval to the given project (no cross-project leakage)', async () => {
    const results = await retrieval.retrieve(
      schemaName,
      randomUUID(),
      'openingstijden',
    );
    expect(results).toHaveLength(0);
  });
});
