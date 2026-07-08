import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { TenantProvisioningService } from '../src/tenancy/tenant-provisioning.service';
import { TenantDbService } from '../src/tenancy/tenant-db.service';
import { runControlPlaneMigrations } from '../src/db/run-control-plane-migrations';
import * as schema from '../src/db/schema';
import { startPg } from './helpers/pg';

describe('knowledge base schema (phase 2 datamodel)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let tenantDb: TenantDbService;
  let t: { schemaName: string };

  beforeAll(async () => {
    ({ container, pool } = await startPg());
    await runControlPlaneMigrations(pool);
    const prov = new TenantProvisioningService(pool, drizzle(pool, { schema }));
    t = await prov.createTenant({ name: 'K', slug: 'k' });
    tenantDb = new TenantDbService(pool);
  });
  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  it('provisions knowledge_sources, documents, chunks in the tenant schema', async () => {
    for (const table of ['knowledge_sources', 'documents', 'chunks']) {
      const r = await pool.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`,
        [t.schemaName, table],
      );
      expect(r.rowCount).toBe(1);
    }
  });

  it('stores an embedding and answers a cosine nearest-neighbour query via shared.vector ops', async () => {
    const dim = 1024;
    const vecA = `[1${',0'.repeat(dim - 1)}]`;
    const vecB = `[0,1${',0'.repeat(dim - 2)}]`;
    await tenantDb.withTenant(t.schemaName, async (db) => {
      await db.execute(
        sql`INSERT INTO knowledge_sources (project_id, type, name)
            VALUES (gen_random_uuid(), 'manual', 's')`,
      );
      const src = await db.execute(
        sql`SELECT id FROM knowledge_sources LIMIT 1`,
      );
      const sourceId = (src.rows[0] as { id: string }).id;
      const doc = await db.execute(
        sql`INSERT INTO documents (source_id, project_id, title, content_hash)
            VALUES (${sourceId}, gen_random_uuid(), 'd', 'h') RETURNING id, project_id`,
      );
      const { id: docId, project_id: projectId } = doc.rows[0] as {
        id: string;
        project_id: string;
      };
      await db.execute(
        sql`INSERT INTO chunks (document_id, project_id, ordinal, text, embedding, tsv)
            VALUES (${docId}, ${projectId}, 0, 'alpha', ${vecA}::shared.vector, to_tsvector('simple','alpha')),
                   (${docId}, ${projectId}, 1, 'beta',  ${vecB}::shared.vector, to_tsvector('simple','beta'))`,
      );
    });

    // Nearest neighbour to vecA must be the 'alpha' chunk — proves the vector
    // operator (shared) resolves under the tenant search_path.
    const nearest = await tenantDb.withTenant(t.schemaName, (db) =>
      db.execute(
        sql`SELECT text FROM chunks ORDER BY embedding <=> ${vecA}::shared.vector LIMIT 1`,
      ),
    );
    expect((nearest.rows[0] as { text: string }).text).toBe('alpha');

    // Full-text index is usable too.
    const fts = await tenantDb.withTenant(t.schemaName, (db) =>
      db.execute(
        sql`SELECT text FROM chunks WHERE tsv @@ plainto_tsquery('simple','beta')`,
      ),
    );
    expect((fts.rows[0] as { text: string }).text).toBe('beta');
  });
});
