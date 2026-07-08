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
import { AnswerService } from '../src/rag/answer.service';
import { FakeLlmProvider } from '../src/rag/fake-llm.provider';
import type { LlmProvider } from '../src/rag/llm-provider';
import { runControlPlaneMigrations } from '../src/db/run-control-plane-migrations';
import * as schema from '../src/db/schema';
import { startPg } from './helpers/pg';

describe('RAG answer pipeline (anti-hallucination)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let tenantDb: TenantDbService;
  let retrieval: RetrievalService;
  let ingestion: IngestionService;
  let schemaName: string;
  let projectId: string;

  const answerWith = (llm: LlmProvider): AnswerService =>
    new AnswerService(tenantDb, retrieval, llm);

  beforeAll(async () => {
    ({ container, pool } = await startPg());
    await runControlPlaneMigrations(pool);
    const prov = new TenantProvisioningService(pool, drizzle(pool, { schema }));
    ({ schemaName } = await prov.createTenant({ name: 'A', slug: 'a' }));
    tenantDb = new TenantDbService(pool);
    const embedder = new FakeEmbeddingProvider(1024);
    ingestion = new IngestionService(tenantDb, new ChunkingService(), embedder);
    retrieval = new RetrievalService(tenantDb, embedder);

    // Project with a low confidence threshold (deterministic with the fake
    // embedder) plus one knowledge document.
    projectId = await tenantDb
      .withTenant(schemaName, async (db) => {
        const p = await db.execute(
          sql`INSERT INTO projects (name, settings)
            VALUES ('Bot', '{"confidenceThreshold":0.1}'::jsonb) RETURNING id`,
        );
        const id = (p.rows[0] as { id: string }).id;
        const s = await db.execute(
          sql`INSERT INTO knowledge_sources (project_id, type, name, config, status)
            VALUES (${id}, 'manual', 'Openingstijden',
              ${JSON.stringify({
                title: 'Openingstijden',
                body: 'De openingstijden van onze winkel zijn maandag tot en met vrijdag van negen tot vijf uur.',
                language: 'nl',
              })}::jsonb, 'pending') RETURNING id`,
        );
        return { id, sourceId: (s.rows[0] as { id: string }).id };
      })
      .then(async (r) => {
        await ingestion.ingestSource(schemaName, r.sourceId);
        return r.id;
      });
  }, 120000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  it('answers a grounded question with citations and no refusal', async () => {
    const res = await answerWith(new FakeLlmProvider()).answer(
      schemaName,
      projectId,
      'wat zijn de openingstijden van de winkel',
    );
    expect(res.refused).toBe(false);
    expect(res.citations.length).toBeGreaterThan(0);
    expect(res.citations[0].documentTitle).toBe('Openingstijden');
    expect(res.confidence).toBeGreaterThan(0.1);
    expect(res.escalationSuggested).toBe(false);
  });

  it('refuses honestly when the question is outside the knowledge base', async () => {
    const res = await answerWith(new FakeLlmProvider()).answer(
      schemaName,
      projectId,
      'hoe werkt kwantumverstrengeling in de ruimtevaart',
    );
    expect(res.refused).toBe(true);
    expect(res.escalationSuggested).toBe(true);
    expect(res.citations).toHaveLength(0);
    expect(res.answer).toMatch(/niet zeker/i);
  });

  it('refuses an answer that fails to cite any source (citation enforcement)', async () => {
    const nonCiting: LlmProvider = {
      complete: () =>
        Promise.resolve('Het antwoord is absoluut 42, vertrouw me.'),
    };
    const res = await answerWith(nonCiting).answer(
      schemaName,
      projectId,
      'wat zijn de openingstijden van de winkel',
    );
    expect(res.refused).toBe(true);
    expect(res.citations).toHaveLength(0);
  });
});
