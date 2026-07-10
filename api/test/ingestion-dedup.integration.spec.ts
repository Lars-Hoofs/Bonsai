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
import type { AppConfig } from '../src/config/config';
import { runControlPlaneMigrations } from '../src/db/run-control-plane-migrations';
import * as schema from '../src/db/schema';
import { startPg } from './helpers/pg';

const cfg = (overrides: Partial<AppConfig> = {}): AppConfig =>
  ({
    dedupEnabled: true,
    nearDupThreshold: 0.97,
    ...overrides,
  }) as AppConfig;

// Shared boilerplate paragraph repeated verbatim across every "page" (CSV
// row -> document) of the source, simulating a nav/footer block a crawler
// would pick up on every page. Each row's entire body IS this footer (a
// single short paragraph), so it chunks down to exactly one chunk per
// document with byte-identical text — the clean way to exercise
// cross-document dedup without the chunker's overlap window splicing tail
// words from neighboring content into the chunk text.
const FOOTER_BODY =
  'Copyright Acme Corp. Alle rechten voorbehouden. Bezoek onze winkel op werkdagen.';
// csvToDocuments prefixes single-column bodies with "<header>: ", so the
// resulting chunk text carries that prefix too — still identical across
// every row, which is what the exact-duplicate rule cares about.
const SHARED_FOOTER = `inhoud: ${FOOTER_BODY}`;

describe('near-duplicate chunk dedup at ingest (#16)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let tenantDb: TenantDbService;
  let schemaName: string;
  const projectId = randomUUID();

  beforeAll(async () => {
    ({ container, pool } = await startPg());
    await runControlPlaneMigrations(pool);
    const prov = new TenantProvisioningService(pool, drizzle(pool, { schema }));
    ({ schemaName } = await prov.createTenant({ name: 'D', slug: 'd' }));
    tenantDb = new TenantDbService(pool);
  }, 180000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  function makeCsv(): string {
    // Three "footer-only" pages (distinct documents, byte-identical body:
    // the boilerplate) plus one page with genuinely unique content, all in
    // the same source.
    const header = 'titel,inhoud';
    const footerRows = ['Pagina een', 'Pagina twee', 'Pagina drie'].map(
      (title) => `"${title}","${FOOTER_BODY}"`,
    );
    const uniqueRow =
      '"Pagina vier","Unieke inhoud die nergens anders voorkomt in deze bron."';
    return [header, ...footerRows, uniqueRow].join('\n');
  }

  async function insertCsvSource(): Promise<string> {
    return tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`INSERT INTO knowledge_sources (project_id, type, name, config, status)
            VALUES (${projectId}, 'csv', 'pages', ${JSON.stringify({
              csv: makeCsv(),
              titleColumn: 'titel',
              bodyColumns: ['inhoud'],
            })}::jsonb, 'pending')
            RETURNING id`,
      );
      return (r.rows[0] as { id: string }).id;
    });
  }

  // Scoped to a single source (each test ingests its own CSV source into a
  // shared tenant schema), so counts aren't polluted by other tests' rows.
  async function countChunksWithText(
    sourceId: string,
    text: string,
  ): Promise<number> {
    const r = await tenantDb.withTenant(schemaName, (db) =>
      db.execute(
        sql`SELECT count(*)::int AS n FROM chunks c
            JOIN documents d ON d.id = c.document_id
            WHERE d.source_id=${sourceId} AND c.text=${text}`,
      ),
    );
    return (r.rows[0] as { n: number }).n;
  }

  it('drops the duplicate footer chunk across documents in the same source when dedup is enabled', async () => {
    const embedder = new FakeEmbeddingProvider(1024);
    const ingestion = new IngestionService(
      tenantDb,
      new ChunkingService(),
      embedder,
      cfg({ dedupEnabled: true }),
    );
    const sourceId = await insertCsvSource();

    await ingestion.ingestSource(schemaName, sourceId);

    const status = await tenantDb.withTenant(schemaName, (db) =>
      db.execute(
        sql`SELECT status FROM knowledge_sources WHERE id=${sourceId}`,
      ),
    );
    expect((status.rows[0] as { status: string }).status).toBe('processed');

    // The identical footer text (fake embedder: identical text -> identical
    // vector, so this is covered by both the exact-text rule and the cosine
    // rule) must be stored exactly once for the whole source, even though it
    // appeared in all three documents.
    const footerCount = await countChunksWithText(sourceId, SHARED_FOOTER);
    expect(footerCount).toBe(1);

    // The unique-content page is untouched — nothing legitimate was dropped.
    const uniqueCount = await countChunksWithText(
      sourceId,
      'inhoud: Unieke inhoud die nergens anders voorkomt in deze bron.',
    );
    expect(uniqueCount).toBe(1);

    // Total chunks for the source: 1 kept footer + 1 unique chunk == 2, even
    // though 4 documents were ingested.
    const totalChunks = await tenantDb.withTenant(schemaName, (db) =>
      db.execute(
        sql`SELECT count(*)::int AS n FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.source_id=${sourceId}`,
      ),
    );
    expect((totalChunks.rows[0] as { n: number }).n).toBe(2);
  });

  it('keeps every duplicate footer chunk when dedup is disabled (proves the toggle)', async () => {
    const embedder = new FakeEmbeddingProvider(1024);
    const ingestion = new IngestionService(
      tenantDb,
      new ChunkingService(),
      embedder,
      cfg({ dedupEnabled: false }),
    );
    const sourceId = await insertCsvSource();

    await ingestion.ingestSource(schemaName, sourceId);

    const footerCount = await countChunksWithText(sourceId, SHARED_FOOTER);
    expect(footerCount).toBeGreaterThan(1);
    expect(footerCount).toBe(3);
  });
});
