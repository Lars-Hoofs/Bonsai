import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { TenantProvisioningService } from '../src/tenancy/tenant-provisioning.service';
import { TenantDbService } from '../src/tenancy/tenant-db.service';
import { ChunkingService } from '../src/knowledge/chunking/chunking.service';
import { FakeEmbeddingProvider } from '../src/knowledge/embedding/fake-embedding.provider';
import type { EmbeddingProvider } from '../src/knowledge/embedding/embedding-provider';
import {
  IngestionService,
  SourceBusyError,
} from '../src/knowledge/ingestion/ingestion.service';
import { KnowledgeSourcesService } from '../src/knowledge/knowledge-sources.service';
import { AuditService } from '../src/audit/audit.service';
import type { AppConfig } from '../src/config/config';
import { DEFAULT_PLAN_LIMITS } from '../src/config/config';
import { PlanLimitsService } from '../src/plan-limits/plan-limits.service';
import { runControlPlaneMigrations } from '../src/db/run-control-plane-migrations';
import * as schema from '../src/db/schema';
import { startPg } from './helpers/pg';

/** An embedder whose `embed` call is far slower than the inline-ingestion
 * timeout, so that timeout can be exercised deterministically and fast. It
 * eventually REJECTS (rather than hanging forever) so the losing background
 * ingestion settles and releases its pooled DB connection — otherwise the
 * open transaction would block afterAll's pool.end() and hang the suite. */
class SlowEmbeddingProvider implements EmbeddingProvider {
  readonly dimension = 1024;
  embed(): Promise<number[][]> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error('slow embedding (test)')), 3000);
    });
  }
}

const cfg = (overrides: Partial<AppConfig> = {}): AppConfig =>
  ({
    ingestionStaleMs: 15 * 60 * 1000,
    ingestionTimeoutMs: 60_000,
    planLimits: DEFAULT_PLAN_LIMITS,
    ...overrides,
  }) as AppConfig;

describe('stale-processing ingestion reaper + inline timeout', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let tenantDb: TenantDbService;
  let schemaName: string;
  const projectId = randomUUID();

  beforeAll(async () => {
    ({ container, pool } = await startPg());
    await runControlPlaneMigrations(pool);
    const prov = new TenantProvisioningService(pool, drizzle(pool, { schema }));
    ({ schemaName } = await prov.createTenant({ name: 'S', slug: 's' }));
    tenantDb = new TenantDbService(pool);
  }, 180000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  async function insertSource(
    config: Record<string, unknown>,
  ): Promise<string> {
    return tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`INSERT INTO knowledge_sources (project_id, type, name, config, status)
            VALUES (${projectId}, 'manual', 'temp', ${JSON.stringify(config)}::jsonb, 'pending')
            RETURNING id`,
      );
      return (r.rows[0] as { id: string }).id;
    });
  }

  async function setStatus(
    sourceId: string,
    status: string,
    updatedAtOffsetMs?: number,
  ): Promise<void> {
    await tenantDb.withTenant(schemaName, (db) =>
      updatedAtOffsetMs === undefined
        ? db.execute(
            sql`UPDATE knowledge_sources SET status=${status}, updated_at=now() WHERE id=${sourceId}`,
          )
        : db.execute(
            sql`UPDATE knowledge_sources SET status=${status}, updated_at=now() + (${updatedAtOffsetMs}::text || ' milliseconds')::interval WHERE id=${sourceId}`,
          ),
    );
  }

  async function getStatus(sourceId: string): Promise<string> {
    const r = await tenantDb.withTenant(schemaName, (db) =>
      db.execute(
        sql`SELECT status FROM knowledge_sources WHERE id=${sourceId}`,
      ),
    );
    return (r.rows[0] as { status: string }).status;
  }

  it('reprocesses a source stuck in processing past the stale threshold', async () => {
    const ingestion = new IngestionService(
      tenantDb,
      new ChunkingService(),
      new FakeEmbeddingProvider(1024),
      cfg({ ingestionStaleMs: 1000 }), // 1s stale threshold for a fast test
    );
    const sourceId = await insertSource({ title: 'T', body: 'hallo wereld' });

    // Simulate a crash mid-ingestion: status left at 'processing' with an
    // updated_at far enough in the past to exceed the 1s stale threshold.
    await setStatus(sourceId, 'processing', -5000);

    await ingestion.ingestSource(schemaName, sourceId);
    expect(await getStatus(sourceId)).toBe('processed');
  });

  it('refuses to clobber a freshly-processing (non-stale) source', async () => {
    const ingestion = new IngestionService(
      tenantDb,
      new ChunkingService(),
      new FakeEmbeddingProvider(1024),
      cfg({ ingestionStaleMs: 15 * 60 * 1000 }), // realistic 15 min threshold
    );
    const sourceId = await insertSource({ title: 'T', body: 'hallo wereld' });

    // updated_at just now: well within the stale threshold, so this looks
    // like a genuinely in-flight run, not an abandoned one.
    await setStatus(sourceId, 'processing');

    await expect(
      ingestion.ingestSource(schemaName, sourceId),
    ).rejects.toBeInstanceOf(SourceBusyError);

    // Status must be untouched — the (hypothetical) owning run, not this
    // rejected caller, is the only one allowed to transition it.
    expect(await getStatus(sourceId)).toBe('processing');
  });

  it('bounds a pathologically slow inline ingestion with a timeout', async () => {
    // A small, explicit timeout: this is the behavior under test (the
    // promise must reject once `ingestionTimeoutMs` elapses), not a
    // performance assertion. We deliberately do NOT assert an upper bound
    // on wall-clock elapsed time here — under CI/container CPU contention
    // the event loop can be delayed arbitrarily, and asserting "rejects
    // within N ms" turns a correctness test into a flaky timing race. The
    // test's own generous `testTimeout` below is the only wall-clock bound:
    // if the timeout mechanism is broken (e.g. never fires), the test fails
    // by hanging until that limit rather than via a tight elapsed-time
    // assertion racing against machine load.
    const ingestionTimeoutMs = 200;
    const ingestion = new IngestionService(
      tenantDb,
      new ChunkingService(),
      new SlowEmbeddingProvider(),
      cfg(),
    );
    const audit = new AuditService(drizzle(pool, { schema }));
    const planLimits = new PlanLimitsService(
      drizzle(pool, { schema }),
      cfg({ ingestionTimeoutMs }),
      tenantDb,
    );
    const knowledge = new KnowledgeSourcesService(
      tenantDb,
      ingestion,
      audit,
      planLimits,
      cfg({ ingestionTimeoutMs }),
    );

    await expect(
      knowledge.create(
        { id: randomUUID(), schemaName },
        projectId,
        {
          type: 'manual',
          name: 'slow',
          // Non-empty body so chunking produces at least one chunk, which is
          // what actually reaches the never-resolving embed() call.
          config: { title: 'Slow', body: 'een twee drie vier vijf zes' },
        },
        randomUUID(),
      ),
    ).rejects.toThrow(/timed out/i);
    // Generous headroom over the 200ms configured timeout so the assertion
    // never depends on a wall-clock race with CI/container contention; a
    // genuinely broken timeout (never rejecting) still fails, just via this
    // per-test timeout instead of a tight elapsed-time expectation.
  }, 30_000);
});
