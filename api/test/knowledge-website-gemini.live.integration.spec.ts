import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { TenantProvisioningService } from '../src/tenancy/tenant-provisioning.service';
import { TenantDbService } from '../src/tenancy/tenant-db.service';
import { ChunkingService } from '../src/knowledge/chunking/chunking.service';
import { HttpEmbeddingProvider } from '../src/knowledge/embedding/http-embedding.provider';
import { IngestionService } from '../src/knowledge/ingestion/ingestion.service';
import { RetrievalService } from '../src/rag/retrieval.service';
import { AnswerService } from '../src/rag/answer.service';
import { HttpLlmProvider } from '../src/rag/http-llm.provider';
import type { AppConfig } from '../src/config/config';
import { runControlPlaneMigrations } from '../src/db/run-control-plane-migrations';
import * as schema from '../src/db/schema';
import { startPg } from './helpers/pg';

// LIVE, end-to-end: real website scrape (SSRF-guarded fetch) -> real Gemini
// embeddings -> retrieval -> real Gemini grounded answer. Costs money + hits the
// network, so it only runs with GEMINI_LIVE=1 and a key (CI skips it).
//   GEMINI_LIVE=1 LLM_API_KEY=<key> pnpm test:int -- --testPathPattern website-gemini.live
const LIVE = process.env.GEMINI_LIVE === '1';
const KEY = process.env.LLM_API_KEY ?? process.env.GEMINI_API_KEY ?? '';
const suite = LIVE && KEY ? describe : describe.skip;

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/openai';

suite('Knowledge website scrape -> RAG — LIVE (Gemini + real fetch)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let answerService: AnswerService;
  let schemaName: string;
  let projectId: string;

  beforeAll(async () => {
    ({ container, pool } = await startPg());
    await runControlPlaneMigrations(pool);
    const prov = new TenantProvisioningService(pool, drizzle(pool, { schema }));
    ({ schemaName } = await prov.createTenant({ name: 'Web', slug: 'web' }));

    const tenantDb = new TenantDbService(pool);
    const embedder = new HttpEmbeddingProvider({
      url: `${GEMINI}/embeddings`,
      apiKey: KEY,
      model: 'gemini-embedding-001',
      dimension: 1024,
    });
    const llm = new HttpLlmProvider({
      url: `${GEMINI}/chat/completions`,
      apiKey: KEY,
      model: 'gemini-2.5-flash',
    });
    const cfg = { selfCheckEnabled: true } as AppConfig;
    const ingestion = new IngestionService(
      tenantDb,
      new ChunkingService(),
      embedder,
    );
    const retrieval = new RetrievalService(tenantDb, embedder);
    answerService = new AnswerService(tenantDb, retrieval, llm, cfg);

    // A website source pointing at a stable public page (example.com's content
    // is famously stable). safeFetch enforces the SSRF policy on this URL.
    projectId = await tenantDb
      .withTenant(schemaName, async (db) => {
        const p = await db.execute(
          sql`INSERT INTO projects (name, settings)
            VALUES ('Site bot', '{"confidenceThreshold":0.2}'::jsonb) RETURNING id`,
        );
        const id = (p.rows[0] as { id: string }).id;
        const s = await db.execute(
          sql`INSERT INTO knowledge_sources (project_id, type, name, config, status)
            VALUES (${id}, 'website', 'Example site',
              ${JSON.stringify({ url: 'https://example.com', language: 'en' })}::jsonb,
              'pending') RETURNING id`,
        );
        return { id, sourceId: (s.rows[0] as { id: string }).id };
      })
      .then(async (r) => {
        await ingestion.ingestSource(schemaName, r.sourceId);
        return r.id;
      });
  }, 120000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (container) await container.stop();
  });

  it('scrapes the site and answers an in-scope question grounded, with a citation', async () => {
    const res = await answerService.answer(
      schemaName,
      projectId,
      'What is this domain intended to be used for?',
    );

    console.log(
      '\n[WEBSITE IN-SCOPE] refused=%s confidence=%s\nanswer: %s\n',
      res.refused,
      res.confidence,
      res.answer,
    );
    expect(res.refused).toBe(false);
    expect(res.citations.length).toBeGreaterThan(0);
    expect(res.answer).toMatch(/example|illustrat|document/i);
  }, 60000);

  it('refuses an out-of-scope question (anti-hallucination, real model)', async () => {
    const res = await answerService.answer(
      schemaName,
      projectId,
      'What are your customer-service opening hours?',
    );

    console.log(
      '\n[WEBSITE OUT-OF-SCOPE] refused=%s\nanswer: %s\n',
      res.refused,
      res.answer,
    );
    // The anti-hallucination property: the model must NOT invent opening hours
    // that aren't on example.com. Acceptable outcomes are a hard refusal OR an
    // honest, cited "not in the sources" answer — both must express uncertainty
    // rather than fabricate a time.
    const honest =
      res.refused ||
      /niet zeker|weet het niet|niet vermeld|geen informatie|not\s+(sure|mentioned|available|specified)|don'?t know/i.test(
        res.answer,
      );
    expect(honest).toBe(true);
  }, 60000);
});
