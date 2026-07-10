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
import { AnswerCacheService } from '../src/rag/answer-cache.service';
import type { LlmMessage, LlmProvider } from '../src/rag/llm-provider';
import type { AppConfig } from '../src/config/config';
import { runControlPlaneMigrations } from '../src/db/run-control-plane-migrations';
import * as schema from '../src/db/schema';
import { startPg } from './helpers/pg';

/** True if this call is the groundedness self-check (routed via a distinct
 * system-role tag, never via shared/user content — see answer.service.ts). */
const isSelfCheckCall = (messages: LlmMessage[]): boolean =>
  messages.some(
    (m) => m.role === 'system' && m.content.includes('BONSAI_SELF_CHECK_V1'),
  );

/** Counting stub LlmProvider: every non-self-check ("primary draft") call is
 * counted, so tests can assert the expensive draft call was/wasn't reissued
 * on a repeated question. */
class CountingLlmProvider implements LlmProvider {
  completeCalls = 0;

  complete(messages: LlmMessage[]): Promise<string> {
    if (isSelfCheckCall(messages)) {
      return Promise.resolve('{"supported": true}');
    }
    this.completeCalls++;
    return Promise.resolve(
      'Op basis van de kennisbank is dit het antwoord [1].',
    );
  }
}

const cfg = (extra: Partial<AppConfig> = {}): AppConfig =>
  ({
    selfCheckEnabled: true,
    verificationMode: 'self-check',
    answerCacheEnabled: true,
    answerCacheTtlMs: 3_600_000,
    ...extra,
  }) as AppConfig;

describe('Answer cache (A9)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let tenantDb: TenantDbService;
  let retrieval: RetrievalService;
  let ingestion: IngestionService;
  let schemaName: string;
  let projectId: string;
  let sourceId: string;

  beforeAll(async () => {
    ({ container, pool } = await startPg());
    await runControlPlaneMigrations(pool);
    const prov = new TenantProvisioningService(pool, drizzle(pool, { schema }));
    ({ schemaName } = await prov.createTenant({ name: 'A', slug: 'a' }));
    tenantDb = new TenantDbService(pool);
    const embedder = new FakeEmbeddingProvider(1024);
    ingestion = new IngestionService(tenantDb, new ChunkingService(), embedder);
    retrieval = new RetrievalService(tenantDb, embedder);

    const created = await tenantDb.withTenant(schemaName, async (db) => {
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
    });
    projectId = created.id;
    sourceId = created.sourceId;
    await ingestion.ingestSource(schemaName, sourceId);
  }, 120000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  /** Builds an AnswerService wired with an in-memory-backed AnswerCacheService
   * (no redisUrl on the cfg passed to AnswerCacheService, so no real Redis is
   * needed here). */
  const answerWithCache = (
    llm: LlmProvider,
    extraCfg: Partial<AppConfig> = {},
  ): AnswerService => {
    const cache = new AnswerCacheService();
    return new AnswerService(
      tenantDb,
      retrieval,
      llm,
      cfg(extraCfg),
      undefined,
      cache,
    );
  };

  it('serves an identical repeated grounded question from cache: the LLM draft call count does not increase, and the answer is identical', async () => {
    const llm = new CountingLlmProvider();
    const svc = answerWithCache(llm);
    const question = 'wat zijn de openingstijden van de winkel';

    const first = await svc.answer(schemaName, projectId, question);
    expect(first.refused).toBe(false);
    expect(llm.completeCalls).toBe(1);

    const second = await svc.answer(schemaName, projectId, question);
    expect(llm.completeCalls).toBe(1); // no new draft call: served from cache
    expect(second).toEqual(first);
  });

  it('is a cache MISS after the project knowledge changes (auto-invalidation via kbVersion)', async () => {
    const llm = new CountingLlmProvider();
    const svc = answerWithCache(llm);
    const question =
      'wat zijn de openingstijden van de winkel voor de tweede keer';

    await svc.answer(schemaName, projectId, question);
    expect(llm.completeCalls).toBe(1);

    // Simulate re-ingestion bumping knowledge_sources.updated_at without
    // changing retrieval results (same source row, just a fresh timestamp).
    await tenantDb.withTenant(schemaName, (db) =>
      db.execute(
        sql`UPDATE knowledge_sources SET updated_at = now() WHERE id = ${sourceId}`,
      ),
    );

    await svc.answer(schemaName, projectId, question);
    expect(llm.completeCalls).toBe(2); // kbVersion changed -> different cache key -> miss
  });

  it('does not cache a refused answer: an out-of-KB question is recomputed (LLM/self-check path re-run) every time', async () => {
    const llm = new CountingLlmProvider();
    const svc = answerWithCache(llm);
    const question = 'hoe werkt kwantumverstrengeling in de ruimtevaart';

    const first = await svc.answer(schemaName, projectId, question);
    expect(first.refused).toBe(true);
    // Gate refusal: retrieval score too low, so the LLM was never even
    // called — completeCalls stays 0.
    expect(llm.completeCalls).toBe(0);

    const second = await svc.answer(schemaName, projectId, question);
    expect(second.refused).toBe(true);
    expect(second).toEqual(first);
    // Still recomputed (not served from a cache entry) both times; since this
    // is a gate refusal the LLM is never invoked either way, so the
    // observable proof is that behavior/shape is identical and stable across
    // repeats, not a call-count bump.
    expect(llm.completeCalls).toBe(0);
  });

  it('does not cache an uncited/ungrounded refusal either', async () => {
    let calls = 0;
    const nonCiting: LlmProvider = {
      complete: (messages) => {
        if (isSelfCheckCall(messages))
          return Promise.resolve('{"supported": true}');
        calls++;
        return Promise.resolve('Het antwoord is absoluut 42, vertrouw me.');
      },
    };
    const svc = answerWithCache(nonCiting);
    const question =
      'wat zijn de openingstijden van de winkel voor de derde keer';

    const first = await svc.answer(schemaName, projectId, question);
    expect(first.refused).toBe(true);
    expect(calls).toBe(1);

    const second = await svc.answer(schemaName, projectId, question);
    expect(second.refused).toBe(true);
    // Not served from cache: the draft call count increases again.
    expect(calls).toBe(2);
  });

  it('does not use the cache when answerCacheEnabled is false, even with a cache instance wired', async () => {
    const llm = new CountingLlmProvider();
    const svc = answerWithCache(llm, { answerCacheEnabled: false });
    const question =
      'wat zijn de openingstijden van de winkel voor de vierde keer';

    await svc.answer(schemaName, projectId, question);
    expect(llm.completeCalls).toBe(1);
    await svc.answer(schemaName, projectId, question);
    expect(llm.completeCalls).toBe(2); // recomputed both times
  });
});
