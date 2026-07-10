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
import type { AppConfig } from '../src/config/config';
import { runControlPlaneMigrations } from '../src/db/run-control-plane-migrations';
import * as schema from '../src/db/schema';
import { startPg } from './helpers/pg';

describe('RAG hybrid retrieval', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let tenantDb: TenantDbService;
  let ingestion: IngestionService;
  let retrieval: RetrievalService;
  let embedder: FakeEmbeddingProvider;
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

  /**
   * Inserts a document with explicit chunks (ordinal + text, one per array
   * entry) directly, bypassing ChunkingService's paragraph-packing — so tests
   * can control chunk boundaries/ordinals precisely instead of fighting the
   * chunker's greedy-pack-to-maxTokens heuristic. Embeddings/tsvectors are
   * real (via the deterministic FakeEmbeddingProvider), so hybrid retrieval
   * behaves normally.
   */
  const addChunkedDocument = async (
    title: string,
    chunkTexts: string[],
    forProjectId: string = projectId,
  ): Promise<string> => {
    return tenantDb.withTenant(schemaName, async (db) => {
      const src = await db.execute(
        sql`INSERT INTO knowledge_sources (project_id, type, name, status)
            VALUES (${forProjectId}, 'manual', ${title}, 'processed') RETURNING id`,
      );
      const sourceId = (src.rows[0] as { id: string }).id;
      const doc = await db.execute(
        sql`INSERT INTO documents (source_id, project_id, title, content_hash, status)
            VALUES (${sourceId}, ${forProjectId}, ${title}, ${randomUUID()}, 'processed')
            RETURNING id`,
      );
      const documentId = (doc.rows[0] as { id: string }).id;
      const vectors = await embedder.embed(chunkTexts);
      for (let i = 0; i < chunkTexts.length; i++) {
        const vecLiteral = `[${vectors[i].join(',')}]`;
        await db.execute(
          sql`INSERT INTO chunks (document_id, project_id, ordinal, text, embedding, tsv)
              VALUES (${documentId}, ${forProjectId}, ${i}, ${chunkTexts[i]},
                      ${vecLiteral}::shared.vector,
                      to_tsvector('dutch', ${chunkTexts[i]}))`,
        );
      }
      return documentId;
    });
  };

  beforeAll(async () => {
    ({ container, pool } = await startPg());
    await runControlPlaneMigrations(pool);
    const prov = new TenantProvisioningService(pool, drizzle(pool, { schema }));
    ({ schemaName } = await prov.createTenant({ name: 'R', slug: 'r' }));
    embedder = new FakeEmbeddingProvider(1024);
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

  describe('retrieveMulti (cross-query RRF fusion)', () => {
    it('fuses candidates across two queries, surfacing docs each query alone would miss', async () => {
      // 'openingstijden' alone should surface the Openingstijden doc;
      // 'retourneren' alone should surface the Retourneren doc. Neither
      // single query is a strong match for the other document. Fusion must
      // recover both.
      const fused = await retrieval.retrieveMulti(schemaName, projectId, [
        'wat zijn de openingstijden van de winkel',
        'kan ik iets retourneren',
      ]);
      const titles = fused.map((c) => c.documentTitle);
      expect(titles).toContain('Openingstijden');
      expect(titles).toContain('Retourneren');
    });

    it('behaves identically to retrieve() for a single-element query array', async () => {
      const single = await retrieval.retrieve(
        schemaName,
        projectId,
        'wat zijn de openingstijden van de winkel',
      );
      const multi = await retrieval.retrieveMulti(schemaName, projectId, [
        'wat zijn de openingstijden van de winkel',
      ]);
      expect(multi).toEqual(single);
    });

    it('scopes retrieveMulti to the given project (no cross-project leakage)', async () => {
      const results = await retrieval.retrieveMulti(schemaName, randomUUID(), [
        'openingstijden',
        'retourneren',
      ]);
      expect(results).toHaveLength(0);
    });
  });

  describe('parent-child retrieval via context-window expansion (A6)', () => {
    const MIDDLE_CHUNK =
      'Onze garantieprocedure schoenenwinkel verloopt via het speciale garantieformulier op de website.';
    const PREV_CHUNK =
      'Introductie assortiment schoenenwinkel: wij verkopen wandelschoenen, sportschoenen en sandalen.';
    const NEXT_CHUNK =
      'Contactgegevens schoenenwinkel: bereikbaar via telefoon, e-mail of het contactformulier.';

    let expandProjectId: string;
    let expandRetrieval: RetrievalService;
    let noExpandRetrieval: RetrievalService;

    beforeAll(async () => {
      // Isolated project so this document's chunks can't be picked up by the
      // other describe blocks' queries (and vice versa).
      expandProjectId = randomUUID();
      await addChunkedDocument(
        'Schoenenwinkel FAQ',
        [PREV_CHUNK, MIDDLE_CHUNK, NEXT_CHUNK],
        expandProjectId,
      );
      // Default window (1, matching RETRIEVAL_WINDOW's config default).
      expandRetrieval = new RetrievalService(tenantDb, embedder);
      // Window 0: must reproduce pre-A6 behavior exactly.
      noExpandRetrieval = new RetrievalService(tenantDb, embedder, undefined, {
        retrievalWindow: 0,
      } as AppConfig);
    });

    it('expands the matched middle chunk with neighboring chunk text (window >= 1)', async () => {
      const results = await expandRetrieval.retrieve(
        schemaName,
        expandProjectId,
        'hoe werkt de garantieprocedure van de schoenenwinkel',
      );
      expect(results.length).toBeGreaterThan(0);
      const top = results[0];
      // The matched chunk (small, precise) is exactly the garantie text.
      expect(top.text).toBe(MIDDLE_CHUNK);
      expect(top.ordinal).toBe(1);
      // expandedText grows to include BOTH neighbors (window=1 => ordinals 0,1,2).
      expect(top.expandedText).toContain(MIDDLE_CHUNK);
      expect(top.expandedText).toContain(PREV_CHUNK);
      expect(top.expandedText).toContain(NEXT_CHUNK);
      expect(top.expandedText.length).toBeGreaterThan(top.text.length);
    });

    it('window=0 leaves expandedText identical to text (pre-A6 behavior)', async () => {
      const results = await noExpandRetrieval.retrieve(
        schemaName,
        expandProjectId,
        'hoe werkt de garantieprocedure van de schoenenwinkel',
      );
      expect(results.length).toBeGreaterThan(0);
      const top = results[0];
      expect(top.text).toBe(MIDDLE_CHUNK);
      expect(top.expandedText).toBe(top.text);
    });
  });
});
