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

// LIVE test: hits the real Google Gemini API and costs money. It only runs when
// GEMINI_LIVE=1 and a key is provided, so the normal CI suite never calls out.
//   GEMINI_LIVE=1 LLM_API_KEY=<key> pnpm test:int -- --testPathPattern gemini.live
const LIVE = process.env.GEMINI_LIVE === '1';
const KEY = process.env.LLM_API_KEY ?? process.env.GEMINI_API_KEY ?? '';
const suite = LIVE && KEY ? describe : describe.skip;

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/openai';

suite('RAG answer pipeline — LIVE Google Gemini', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let answerService: AnswerService;
  let schemaName: string;
  let projectId: string;

  beforeAll(async () => {
    ({ container, pool } = await startPg());
    await runControlPlaneMigrations(pool);
    const prov = new TenantProvisioningService(pool, drizzle(pool, { schema }));
    ({ schemaName } = await prov.createTenant({ name: 'Demo', slug: 'demo' }));

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

    projectId = await tenantDb
      .withTenant(schemaName, async (db) => {
        const p = await db.execute(
          sql`INSERT INTO projects (name, settings)
            VALUES ('Support bot', '{"confidenceThreshold":0.2}'::jsonb) RETURNING id`,
        );
        const id = (p.rows[0] as { id: string }).id;
        const s = await db.execute(
          sql`INSERT INTO knowledge_sources (project_id, type, name, config, status)
            VALUES (${id}, 'manual', 'Openingstijden & retour',
              ${JSON.stringify({
                title: 'Openingstijden & retour',
                body: 'De klantenservice van Bonsai Media is bereikbaar van maandag tot en met vrijdag van 9:00 tot 17:00 uur (CET). Retourneren kan binnen 30 dagen na aankoop met de originele bon.',
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
    if (pool) await pool.end();
    if (container) await container.stop();
  });

  it('answers an in-scope question grounded, with citations, from the real model', async () => {
    const res = await answerService.answer(
      schemaName,
      projectId,
      'Tot hoe laat kan ik jullie klantenservice bereiken?',
    );

    console.log(
      '\n[IN-SCOPE] refused=%s confidence=%s\nanswer: %s\ncitations: %s\n',
      res.refused,
      res.confidence,
      res.answer,
      JSON.stringify(res.citations),
    );
    expect(res.refused).toBe(false);
    expect(res.citations.length).toBeGreaterThan(0);
    expect(res.answer).toMatch(/17|vijf/i);
  }, 60000);

  it('refuses honestly on an out-of-scope question (real-model anti-hallucination)', async () => {
    const res = await answerService.answer(
      schemaName,
      projectId,
      'Wat is de hoofdstad van Australië en hoeveel inwoners heeft die?',
    );

    console.log(
      '\n[OUT-OF-SCOPE] refused=%s confidence=%s\nanswer: %s\n',
      res.refused,
      res.confidence,
      res.answer,
    );
    expect(res.refused).toBe(true);
    expect(res.citations).toHaveLength(0);
  }, 60000);
});
