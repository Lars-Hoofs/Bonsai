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
import { PlanLimitsService } from '../plan-limits/plan-limits.service';
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
  recrawlIntervalMs: number | null;
  createdAt: string;
  updatedAt: string;
}

/** One row of the source health overview (roadmap #20): the source's own
 * last-crawl status/time plus aggregate document/chunk counts and how many of
 * its documents are currently in error. */
export interface SourceHealthRow extends SourceRow {
  documentCount: number;
  chunkCount: number;
  failedDocumentCount: number;
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
    recrawlIntervalMs:
      r.recrawl_interval_ms == null ? null : Number(r.recrawl_interval_ms),
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
    private readonly planLimits: PlanLimitsService,
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
    await this.planLimits.assertCanCreateSource(
      tenant.id,
      tenant.schemaName,
      projectId,
    );
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

  /**
   * Triggers an immediate re-crawl / re-ingest of a source ("crawl now",
   * roadmap #19). Functionally the same as {@link reprocess} — it re-runs
   * ingestion (background-enqueued when a Redis queue is active, else inline)
   * — but records an audit entry since it is an explicit operator action.
   */
  async crawlNow(
    tenant: { id: string; schemaName: string },
    projectId: string,
    id: string,
    actorUserId: string,
  ): Promise<SourceRow> {
    await this.get(tenant.schemaName, projectId, id); // 404 if not in project
    await this.ingestOrEnqueue(tenant.schemaName, id);
    await this.audit.record({
      tenantId: tenant.id,
      actorUserId,
      action: 'knowledge_source.crawl_now',
      resource: `knowledge_source:${id}`,
    });
    return this.get(tenant.schemaName, projectId, id);
  }

  /**
   * Sets (or clears, with `null`) a source's recurring re-crawl interval
   * (roadmap #19). The scheduled scan (see CrawlService) honours this per-source
   * interval for website sources; a `null` interval falls back to the global
   * scan cadence. Setting a schedule does not itself trigger a crawl.
   */
  async setSchedule(
    tenant: { id: string; schemaName: string },
    projectId: string,
    id: string,
    recrawlIntervalMs: number | null,
    actorUserId: string,
  ): Promise<SourceRow> {
    const updated = await this.tenantDb.withTenant(
      tenant.schemaName,
      async (db) => {
        const r = await db.execute(
          sql`UPDATE knowledge_sources
              SET recrawl_interval_ms=${recrawlIntervalMs}, updated_at=now()
              WHERE id=${id} AND project_id=${projectId}
              RETURNING id`,
        );
        return r.rows.length > 0;
      },
    );
    if (!updated) throw new NotFoundException('Knowledge source not found');
    await this.audit.record({
      tenantId: tenant.id,
      actorUserId,
      action: 'knowledge_source.schedule_updated',
      resource: `knowledge_source:${id}`,
      metadata: { recrawlIntervalMs },
    });
    return this.get(tenant.schemaName, projectId, id);
  }

  /**
   * Aggregate health overview across all sources in a project (roadmap #20):
   * each source's last-crawl status/time and error, plus its document and chunk
   * counts and how many of its documents are currently in a failed state. One
   * grouped query (no per-source round-trips) so it scales with source count.
   */
  async healthOverview(
    schemaName: string,
    projectId: string,
  ): Promise<SourceHealthRow[]> {
    return this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`SELECT s.*,
                   (SELECT count(*)::int FROM documents d
                      WHERE d.source_id=s.id) AS document_count,
                   (SELECT count(*)::int FROM documents d
                      WHERE d.source_id=s.id AND d.status='failed')
                     AS failed_document_count,
                   (SELECT count(*)::int FROM chunks c
                      JOIN documents d ON d.id=c.document_id
                      WHERE d.source_id=s.id) AS chunk_count
            FROM knowledge_sources s
            WHERE s.project_id=${projectId}
            ORDER BY s.created_at`,
      );
      return r.rows.map((row) => ({
        ...mapSource(row),
        documentCount: row.document_count as number,
        chunkCount: row.chunk_count as number,
        failedDocumentCount: row.failed_document_count as number,
      }));
    });
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
      enabled: boolean;
      chunkCount: number;
    }>
  > {
    return this.tenantDb.withTenant(schemaName, async (db) => {
      const r = sourceId
        ? await db.execute(
            sql`SELECT d.id, d.source_id, d.title, d.status, d.language, d.enabled,
                   (SELECT count(*)::int FROM chunks c WHERE c.document_id=d.id) AS chunk_count
                FROM documents d WHERE d.project_id=${projectId} AND d.source_id=${sourceId} ORDER BY d.created_at`,
          )
        : await db.execute(
            sql`SELECT d.id, d.source_id, d.title, d.status, d.language, d.enabled,
                   (SELECT count(*)::int FROM chunks c WHERE c.document_id=d.id) AS chunk_count
                FROM documents d WHERE d.project_id=${projectId} ORDER BY d.created_at`,
          );
      return r.rows.map((row) => ({
        id: row.id as string,
        sourceId: row.source_id as string,
        title: row.title as string,
        status: row.status as string,
        language: row.language as string,
        enabled: row.enabled as boolean,
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
    enabled: boolean;
    chunks: Array<{ ordinal: number; text: string; tokenCount: number }>;
  }> {
    const result = await this.tenantDb.withTenant(schemaName, async (db) => {
      const d = await db.execute(
        sql`SELECT id, title, status, language, enabled FROM documents WHERE id=${documentId} AND project_id=${projectId}`,
      );
      const doc = d.rows[0] as
        | {
            id: string;
            title: string;
            status: string;
            language: string;
            enabled: boolean;
          }
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

  /**
   * Toggles a single document on/off for retrieval (#21). A disabled document
   * (and all its chunks) is excluded from retrieval by RetrievalService's
   * `documents.enabled` filter, without deleting any rows — re-enabling makes
   * it retrievable again immediately. Idempotent: setting the same value again
   * simply returns the (unchanged) document.
   */
  async setDocumentEnabled(
    tenant: { id: string; schemaName: string },
    projectId: string,
    documentId: string,
    enabled: boolean,
    actorUserId: string,
  ): Promise<{
    id: string;
    title: string;
    status: string;
    language: string;
    enabled: boolean;
    chunks: Array<{ ordinal: number; text: string; tokenCount: number }>;
  }> {
    const updated = await this.tenantDb.withTenant(
      tenant.schemaName,
      async (db) => {
        const r = await db.execute(
          sql`UPDATE documents SET enabled=${enabled}, updated_at=now()
              WHERE id=${documentId} AND project_id=${projectId} RETURNING id`,
        );
        return r.rows.length > 0;
      },
    );
    if (!updated) throw new NotFoundException('Document not found');
    await this.audit.record({
      tenantId: tenant.id,
      actorUserId,
      action: enabled ? 'document.enabled' : 'document.disabled',
      resource: `document:${documentId}`,
    });
    return this.getDocument(tenant.schemaName, projectId, documentId);
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
