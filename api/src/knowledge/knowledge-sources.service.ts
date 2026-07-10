import {
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { APP_CONFIG } from '../config/config';
import type { AppConfig } from '../config/config';
import { TenantDbService } from '../tenancy/tenant-db.service';
import { IngestionService } from './ingestion/ingestion.service';
import { IngestionQueueService } from './ingestion/ingestion-queue.service';
import { validateSourceConfig } from './source-config-validation';

const DEFAULT_INGESTION_TIMEOUT_MS = 60_000;

/**
 * Bounds a promise to at most `timeoutMs`. Ingestion itself keeps running in
 * the background past the timeout (there is no cancellation of the
 * in-flight work) — this only stops the HTTP request from waiting on it, so
 * a pathological source (slow fetch, huge embedding batch) cannot hold the
 * request/worker open indefinitely. Callers must not assume the underlying
 * operation actually stopped.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Ingestion timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

export interface SourceRow {
  id: string;
  projectId: string;
  type: string;
  name: string;
  status: string;
  errorDetail: string | null;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function mapSource(r: Record<string, unknown>): SourceRow {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    type: r.type as string,
    name: r.name as string,
    status: r.status as string,
    errorDetail: (r.error_detail as string | null) ?? null,
    lastSyncedAt:
      r.last_synced_at instanceof Date ? r.last_synced_at.toISOString() : null,
    createdAt:
      r.created_at instanceof Date
        ? r.created_at.toISOString()
        : String(r.created_at),
    updatedAt:
      r.updated_at instanceof Date
        ? r.updated_at.toISOString()
        : String(r.updated_at),
  };
}

@Injectable()
export class KnowledgeSourcesService {
  private readonly ingestionTimeoutMs: number;

  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly ingestion: IngestionService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) cfg?: AppConfig,
    // Optional: when a Redis-backed queue is active, ingestion runs in the
    // background instead of inline. Absent (tests/dev without Redis) -> inline.
    @Optional() private readonly queue?: IngestionQueueService,
  ) {
    this.ingestionTimeoutMs =
      cfg?.ingestionTimeoutMs ?? DEFAULT_INGESTION_TIMEOUT_MS;
  }

  /**
   * Background-enqueue when a Redis queue is active (request returns fast, the
   * source stays 'pending'); otherwise ingest inline bounded by a timeout.
   */
  private async ingestOrEnqueue(
    schemaName: string,
    sourceId: string,
  ): Promise<void> {
    if (this.queue?.isEnabled()) {
      await this.queue.enqueue(schemaName, sourceId);
    } else {
      await this.ingestBounded(schemaName, sourceId);
    }
  }

  /**
   * Runs ingestion inline (in the HTTP request path) but bounded by
   * `ingestionTimeoutMs`: a pathological source (slow website fetch, huge
   * embedding batch) can no longer hold the request open indefinitely. The
   * ingestion itself is left running in the background past the timeout —
   * `ingestSource` already leaves the row at 'processing' with a fresh
   * `updated_at` at that point, which the stale-processing reaper (see
   * IngestionService/CrawlService) will recover if this particular run never
   * reaches its own catch block. We swallow (but log) a post-timeout
   * rejection/resolution here purely to avoid an unhandled promise rejection;
   * the request itself has already returned by then.
   *
   * Deferred optimization: move ingestion to a background queue entirely
   * (BullMQ already exists for re-crawl) so the request never waits on it at
   * all — out of scope here.
   */
  private async ingestBounded(
    schemaName: string,
    sourceId: string,
  ): Promise<void> {
    const run = this.ingestion.ingestSource(schemaName, sourceId);
    run.catch(() => {
      /* handled via withTimeout below, or intentionally ignored once the
       * request has already returned past the timeout. */
    });
    await withTimeout(run, this.ingestionTimeoutMs);
  }

  /** Creates a source (status pending) and ingests it synchronously. */
  async create(
    tenant: { id: string; schemaName: string },
    projectId: string,
    input: { type: string; name: string; config: Record<string, unknown> },
    actorUserId: string,
  ): Promise<SourceRow> {
    validateSourceConfig(input.type, input.config);
    const id = await this.tenantDb.withTenant(tenant.schemaName, async (db) => {
      const r = await db.execute(
        sql`INSERT INTO knowledge_sources (project_id, type, name, config, status)
            VALUES (${projectId}, ${input.type}, ${input.name}, ${JSON.stringify(input.config)}::jsonb, 'pending')
            RETURNING id`,
      );
      return (r.rows[0] as { id: string }).id;
    });
    await this.ingestOrEnqueue(tenant.schemaName, id);
    await this.audit.record({
      tenantId: tenant.id,
      actorUserId,
      action: 'knowledge_source.created',
      resource: `knowledge_source:${id}`,
      metadata: { type: input.type },
    });
    return this.get(tenant.schemaName, projectId, id);
  }

  /** Maps a raw `knowledge_sources` row to the public `SourceRow` shape.
   * Exposed so sibling services (e.g. the article editor) can reuse the same
   * base mapping without duplicating it. */
  mapSourceRow(row: Record<string, unknown>): SourceRow {
    return mapSource(row);
  }

  async list(schemaName: string, projectId: string): Promise<SourceRow[]> {
    return this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`SELECT * FROM knowledge_sources WHERE project_id=${projectId} ORDER BY created_at`,
      );
      return r.rows.map(mapSource);
    });
  }

  async get(
    schemaName: string,
    projectId: string,
    id: string,
  ): Promise<SourceRow> {
    const rows = await this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`SELECT * FROM knowledge_sources WHERE id=${id} AND project_id=${projectId}`,
      );
      return r.rows;
    });
    if (!rows[0]) throw new NotFoundException('Knowledge source not found');
    return mapSource(rows[0]);
  }

  /**
   * Re-runs ingestion for an existing source. Rejects with the same error
   * IngestionService throws (e.g. `SourceBusyError`) if the source is
   * currently owned by a still-live, non-stale 'processing' run.
   */
  async reprocess(
    schemaName: string,
    projectId: string,
    id: string,
  ): Promise<SourceRow> {
    await this.get(schemaName, projectId, id); // 404 if not in this project
    await this.ingestOrEnqueue(schemaName, id);
    return this.get(schemaName, projectId, id);
  }

  async listDocuments(
    schemaName: string,
    projectId: string,
    sourceId?: string,
  ): Promise<
    Array<{
      id: string;
      sourceId: string;
      title: string;
      status: string;
      language: string;
      chunkCount: number;
    }>
  > {
    return this.tenantDb.withTenant(schemaName, async (db) => {
      const r = sourceId
        ? await db.execute(
            sql`SELECT d.id, d.source_id, d.title, d.status, d.language,
                   (SELECT count(*)::int FROM chunks c WHERE c.document_id=d.id) AS chunk_count
                FROM documents d WHERE d.project_id=${projectId} AND d.source_id=${sourceId} ORDER BY d.created_at`,
          )
        : await db.execute(
            sql`SELECT d.id, d.source_id, d.title, d.status, d.language,
                   (SELECT count(*)::int FROM chunks c WHERE c.document_id=d.id) AS chunk_count
                FROM documents d WHERE d.project_id=${projectId} ORDER BY d.created_at`,
          );
      return r.rows.map((row) => ({
        id: row.id as string,
        sourceId: row.source_id as string,
        title: row.title as string,
        status: row.status as string,
        language: row.language as string,
        chunkCount: row.chunk_count as number,
      }));
    });
  }

  async getDocument(
    schemaName: string,
    projectId: string,
    documentId: string,
  ): Promise<{
    id: string;
    title: string;
    status: string;
    language: string;
    chunks: Array<{ ordinal: number; text: string; tokenCount: number }>;
  }> {
    const result = await this.tenantDb.withTenant(schemaName, async (db) => {
      const d = await db.execute(
        sql`SELECT id, title, status, language FROM documents WHERE id=${documentId} AND project_id=${projectId}`,
      );
      const doc = d.rows[0] as
        | { id: string; title: string; status: string; language: string }
        | undefined;
      if (!doc) return null;
      const c = await db.execute(
        sql`SELECT ordinal, text, token_count FROM chunks WHERE document_id=${documentId} ORDER BY ordinal`,
      );
      const chunks = c.rows.map((row) => ({
        ordinal: row.ordinal as number,
        text: row.text as string,
        tokenCount: row.token_count as number,
      }));
      return { ...doc, chunks };
    });
    if (!result) throw new NotFoundException('Document not found');
    return result;
  }

  async remove(
    tenant: { id: string; schemaName: string },
    projectId: string,
    id: string,
    actorUserId: string,
  ): Promise<void> {
    const deleted = await this.tenantDb.withTenant(
      tenant.schemaName,
      async (db) => {
        const r = await db.execute(
          sql`DELETE FROM knowledge_sources WHERE id=${id} AND project_id=${projectId} RETURNING id`,
        );
        return r.rows.length > 0;
      },
    );
    if (!deleted) throw new NotFoundException('Knowledge source not found');
    await this.audit.record({
      tenantId: tenant.id,
      actorUserId,
      action: 'knowledge_source.deleted',
      resource: `knowledge_source:${id}`,
    });
  }
}
