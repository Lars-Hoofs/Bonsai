import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { APP_CONFIG } from '../../config/config';
import type { AppConfig } from '../../config/config';
import { TenantDbService } from '../../tenancy/tenant-db.service';
import { ChunkingService } from '../chunking/chunking.service';
import { EMBEDDING_PROVIDER } from '../embedding/embedding-provider';
import type { EmbeddingProvider } from '../embedding/embedding-provider';
import { csvToDocuments, RawDocument } from './csv';
import { extractTitle, htmlToText } from './extract-text';
import { safeFetch } from '../../common/safe-fetch';
import { crawlSite } from './site-crawler';
import {
  WEBSITE_CRAWL_DEFAULT_MAX_DEPTH,
  WEBSITE_CRAWL_DEFAULT_MAX_PAGES,
  WEBSITE_CRAWL_MAX_DEPTH_CAP,
  WEBSITE_CRAWL_MAX_PAGES_CAP,
} from '../source-config-validation';
import { MetricsService } from '../../metrics/metrics.service';
import { createDeduper } from './dedup';
import type { Deduper } from './dedup';

/** Fallback used when IngestionService is constructed directly (tests, the
 * BullMQ CrawlService) without an AppConfig — matches the config default. */
const DEFAULT_STALE_MS = 900_000;

/** Fallbacks matching the config defaults, used when IngestionService is
 * constructed directly without an AppConfig (see DEFAULT_STALE_MS above). */
const DEFAULT_DEDUP_ENABLED = true;
const DEFAULT_NEAR_DUP_THRESHOLD = 0.97;

/** A source is considered abandoned (crashed mid-ingestion, never reached the
 * catch block) if it has sat in 'processing' longer than this. */
export function isStaleProcessing(
  status: string,
  updatedAt: Date,
  staleMs: number,
): boolean {
  return status === 'processing' && Date.now() - updatedAt.getTime() >= staleMs;
}

/**
 * Thrown when a source is already being processed by a still-live run (i.e.
 * 'processing' but not yet stale). Deliberately does NOT flip the source to
 * 'failed' — unlike other ingestion errors — because the other, genuinely
 * in-flight run owns that status transition; doing so here would race it.
 */
export class SourceBusyError extends Error {
  constructor(sourceId: string) {
    super(`Source ${sourceId} is already being processed`);
    this.name = 'SourceBusyError';
  }
}

/** Maps a document language to a Postgres text-search configuration. */
function regconfig(language: string): string {
  if (language.startsWith('nl')) return 'dutch';
  if (language.startsWith('en')) return 'english';
  return 'simple';
}

function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
}

function docHash(raw: { title: string; body: string }): string {
  return createHash('sha256').update(`${raw.title}\n${raw.body}`).digest('hex');
}

/** Fetches a single page's HTML via the SSRF-guarded `safeFetch`. Throws a
 * generic error on any failure (network error, non-2xx, blocked URL): the
 * raw error must not leak to the tenant, or it becomes an oracle for
 * scanning our internal network. Used for both the single-page website path
 * and as the underlying page-fetcher for `crawlSite`. */
async function fetchPageBody(url: string): Promise<string> {
  let res: { status: number; body: string };
  try {
    res = await safeFetch(url, { maxBytes: 5_000_000 });
  } catch {
    throw new Error('Kon de opgegeven URL niet ophalen');
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error('Kon de opgegeven URL niet ophalen');
  }
  return res.body;
}

@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);

  private readonly staleMs: number;
  private readonly dedupEnabled: boolean;
  private readonly nearDupThreshold: number;

  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly chunking: ChunkingService,
    @Inject(EMBEDDING_PROVIDER) private readonly embedder: EmbeddingProvider,
    @Optional() @Inject(APP_CONFIG) cfg?: AppConfig,
    // Optional so tests that construct IngestionService directly (`new
    // IngestionService(tenantDb, chunking, embedder)`, without a DI
    // container) keep working unchanged; falls back to a no-op when absent.
    @Optional() private readonly metrics?: MetricsService,
  ) {
    this.staleMs = cfg?.ingestionStaleMs ?? DEFAULT_STALE_MS;
    this.dedupEnabled = cfg?.dedupEnabled ?? DEFAULT_DEDUP_ENABLED;
    this.nearDupThreshold = cfg?.nearDupThreshold ?? DEFAULT_NEAR_DUP_THRESHOLD;
  }

  /**
   * (Re)ingests a source: extracts raw documents from its config, then for each
   * document chunks -> embeds -> indexes, replacing any prior chunks. Sets
   * source/document status transitions and records errors. Idempotent.
   *
   * Guards against clobbering a genuinely in-flight ingestion: a source whose
   * status is already 'processing' is only re-entered if it has gone stale
   * (no update in `staleMs`), i.e. the previous run crashed without ever
   * reaching the catch block below, so it would otherwise be stuck forever.
   */
  async ingestSource(schemaName: string, sourceId: string): Promise<void> {
    // Read-then-guard happens in its own (implicit) transaction, separate
    // from the try/catch below: if another run genuinely owns this source
    // right now, bail out without touching its status at all — only the
    // owning run's own try/catch may transition it to 'processed'/'failed'.
    const initial = await this.tenantDb.withTenant(schemaName, (db) =>
      this.loadSource(db, sourceId),
    );
    if (
      initial.status === 'processing' &&
      !isStaleProcessing(initial.status, initial.updatedAt, this.staleMs)
    ) {
      throw new SourceBusyError(sourceId);
    }

    try {
      await this.tenantDb.withTenant(schemaName, async (db) => {
        const src = await this.loadSource(db, sourceId);
        await db.execute(
          sql`UPDATE knowledge_sources SET status='processing', error_detail=NULL, updated_at=now() WHERE id=${sourceId}`,
        );
        const raws = await this.extract(src.type, src.config);
        // Scoped to this single source-ingestion run: accumulates KEPT
        // chunks across ALL documents of the source (so boilerplate
        // repeated *across* documents/pages — e.g. crawled nav/footer text —
        // is deduped too, not just within one document). A fresh instance is
        // created on every ingestSource call, never shared across sources or
        // runs. `undefined` when dedup is disabled, so downstream code takes
        // the no-op path.
        const deduper = this.dedupEnabled ? createDeduper() : undefined;

        if (src.type === 'website') {
          // Website sources (single-page or multi-page crawl) are keyed by
          // origin_url and change-detected per page: unchanged pages are
          // left untouched (no re-chunk/re-embed), changed pages get their
          // chunks replaced, new pages are inserted, and pages no longer
          // present in this crawl are deleted.
          await this.upsertWebsiteDocuments(
            db,
            sourceId,
            src.projectId,
            raws,
            deduper,
          );
          await db.execute(
            sql`UPDATE knowledge_sources SET status='processed', last_synced_at=now(), updated_at=now() WHERE id=${sourceId}`,
          );
          return;
        }

        // Change detection: if the extracted content hashes to exactly the same
        // set as what is already stored, nothing changed — skip the (expensive)
        // re-embedding entirely and just refresh last_synced_at.
        const newHashes = raws.map(docHash).sort();
        const existing = await db.execute(
          sql`SELECT content_hash FROM documents WHERE source_id=${sourceId}`,
        );
        const oldHashes = (existing.rows as { content_hash: string }[])
          .map((r) => r.content_hash)
          .sort();
        const unchanged =
          newHashes.length > 0 &&
          newHashes.length === oldHashes.length &&
          newHashes.every((h, i) => h === oldHashes[i]);

        if (unchanged) {
          await db.execute(
            sql`UPDATE knowledge_sources SET status='processed', last_synced_at=now(), updated_at=now() WHERE id=${sourceId}`,
          );
          return;
        }

        // Content changed — replace prior documents and re-embed.
        await db.execute(
          sql`DELETE FROM documents WHERE source_id=${sourceId}`,
        );
        for (const raw of raws) {
          await this.ingestDocument(db, sourceId, src.projectId, raw, deduper);
        }
        await db.execute(
          sql`UPDATE knowledge_sources SET status='processed', last_synced_at=now(), updated_at=now() WHERE id=${sourceId}`,
        );
      });
      this.metrics?.ingestionTotal.inc({ status: 'processed' });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.error(`Ingestion failed for source ${sourceId}: ${detail}`);
      await this.tenantDb.withTenant(schemaName, (db) =>
        db.execute(
          sql`UPDATE knowledge_sources SET status='failed', error_detail=${detail}, updated_at=now() WHERE id=${sourceId}`,
        ),
      );
      this.metrics?.ingestionTotal.inc({ status: 'failed' });
      throw err;
    }
  }

  private async loadSource(
    db: NodePgDatabase,
    sourceId: string,
  ): Promise<{
    type: string;
    projectId: string;
    config: Record<string, unknown>;
    status: string;
    updatedAt: Date;
  }> {
    const r = await db.execute(
      sql`SELECT type, project_id, config, status, updated_at FROM knowledge_sources WHERE id=${sourceId}`,
    );
    const row = r.rows[0] as
      | {
          type: string;
          project_id: string;
          config: Record<string, unknown>;
          status: string;
          updated_at: Date;
        }
      | undefined;
    if (!row) throw new Error(`Source ${sourceId} not found`);
    return {
      type: row.type,
      projectId: row.project_id,
      config: row.config,
      status: row.status,
      // Coerce to a Date: raw sql`` results can surface timestamptz as a
      // string (vs. a Date via the typed query builder), which broke
      // isStaleProcessing's updatedAt.getTime(). new Date() is a no-op on a
      // Date and parses the ISO string otherwise.
      updatedAt: new Date(row.updated_at),
    };
  }

  private async extract(
    type: string,
    config: Record<string, unknown>,
  ): Promise<RawDocument[]> {
    const str = (v: unknown, fallback = ''): string =>
      typeof v === 'string' ? v : fallback;
    // 'upload' arrives with text already extracted by the controller, and
    // 'article' arrives with its rich-text already rendered to a Markdown
    // `body` by ArticlesService, so both are treated like a manual document.
    if (type === 'manual' || type === 'upload' || type === 'article') {
      return [
        {
          title: str(config.title, 'Untitled'),
          body: str(config.body),
          language:
            typeof config.language === 'string' ? config.language : undefined,
        },
      ];
    }
    if (type === 'csv') {
      const csv = str(config.csv);
      return csvToDocuments(csv, {
        titleColumn: config.titleColumn as string | undefined,
        bodyColumns: config.bodyColumns as string[] | undefined,
      });
    }
    if (type === 'website') {
      const url = str(config.url);
      if (!url) throw new Error('website source requires a url');

      if (config.crawl === true) {
        const maxPages = Math.min(
          typeof config.maxPages === 'number'
            ? config.maxPages
            : WEBSITE_CRAWL_DEFAULT_MAX_PAGES,
          WEBSITE_CRAWL_MAX_PAGES_CAP,
        );
        const maxDepth = Math.min(
          typeof config.maxDepth === 'number'
            ? config.maxDepth
            : WEBSITE_CRAWL_DEFAULT_MAX_DEPTH,
          WEBSITE_CRAWL_MAX_DEPTH_CAP,
        );
        let pages: { url: string; html: string }[];
        try {
          pages = await crawlSite(url, { maxPages, maxDepth }, (pageUrl) =>
            fetchPageBody(pageUrl),
          );
        } catch {
          // Same generic-message rationale as the single-page path below.
          throw new Error('Kon de opgegeven URL niet ophalen');
        }
        return pages.map((p) => ({
          title: extractTitle(p.html, p.url),
          body: htmlToText(p.html),
          originUrl: p.url,
        }));
      }

      const html = await fetchPageBody(url);
      return [
        {
          title: extractTitle(html, url),
          body: htmlToText(html),
          originUrl: url,
        },
      ];
    }
    throw new Error(`Unsupported source type for ingestion: ${type}`);
  }

  private async ingestDocument(
    db: NodePgDatabase,
    sourceId: string,
    projectId: string,
    raw: RawDocument,
    deduper?: Deduper,
  ): Promise<void> {
    const language = raw.language ?? 'nl';
    const contentHash = docHash(raw);

    const inserted = await db.execute(
      sql`INSERT INTO documents (source_id, project_id, title, origin_url, content_hash, language, status)
          VALUES (${sourceId}, ${projectId}, ${raw.title}, ${raw.originUrl ?? null}, ${contentHash}, ${language}, 'processing')
          RETURNING id`,
    );
    const documentId = (inserted.rows[0] as { id: string }).id;
    await this.writeChunksForDocument(
      db,
      documentId,
      projectId,
      raw,
      language,
      deduper,
    );
  }

  /** Chunks, embeds, and inserts `raw.body` under an already-created
   * `documentId`, then marks the document processed. Shared by fresh
   * document inserts and by re-chunking a changed page under its existing
   * document id (the per-page website upsert path).
   *
   * When `deduper` is provided (dedup enabled), each embedded chunk is
   * passed through `deduper.shouldKeep` and only kept chunks are inserted —
   * dropping exact duplicates (identical normalized text) and near-duplicates
   * (embedding cosine >= threshold) against anything already kept earlier in
   * this same source-ingestion run, including chunks from other documents.
   * If every chunk of this document is dropped, the document row is still
   * created/updated and marked 'processed' with zero chunks, rather than
   * left dangling or causing an error. */
  private async writeChunksForDocument(
    db: NodePgDatabase,
    documentId: string,
    projectId: string,
    raw: RawDocument,
    language: string,
    deduper?: Deduper,
  ): Promise<void> {
    const chunks = this.chunking.chunk(raw.body);
    if (chunks.length === 0) {
      await db.execute(
        sql`UPDATE documents SET status='processed', updated_at=now() WHERE id=${documentId}`,
      );
      return;
    }

    const vectors = await this.embedder.embed(chunks.map((c) => c.text));
    this.metrics?.embeddingCallsTotal.inc({
      provider: this.embedder.constructor.name,
    });
    const cfg = regconfig(language);
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const vec = vectors[i];
      if (deduper && !deduper.shouldKeep(c.text, vec, this.nearDupThreshold)) {
        continue;
      }
      const vecLiteral = toVectorLiteral(vec);
      await db.execute(
        sql`INSERT INTO chunks (document_id, project_id, ordinal, text, token_count, section, embedding, tsv)
            VALUES (${documentId}, ${projectId}, ${c.ordinal}, ${c.text}, ${c.tokenCount}, ${c.section ?? null},
                    ${vecLiteral}::shared.vector, to_tsvector(${cfg}::regconfig, ${c.text}))`,
      );
    }
    await db.execute(
      sql`UPDATE documents SET status='processed', updated_at=now() WHERE id=${documentId}`,
    );
  }

  /**
   * Per-page upsert for website sources, keyed by (source_id, origin_url):
   *  - same content_hash as stored -> left untouched (no re-chunk/re-embed).
   *  - different hash -> chunks replaced, content_hash updated (re-embed).
   *  - not previously present -> inserted (and embedded).
   *  - previously present but absent from this crawl -> document (and its
   *    chunks, via ON DELETE CASCADE) deleted.
   *
   * This is what makes a re-crawl only re-embed changed/new pages instead of
   * the delete-all-then-reinsert behavior used for other source types.
   */
  private async upsertWebsiteDocuments(
    db: NodePgDatabase,
    sourceId: string,
    projectId: string,
    raws: RawDocument[],
    deduper?: Deduper,
  ): Promise<void> {
    const existing = await db.execute(
      sql`SELECT id, origin_url, content_hash FROM documents WHERE source_id=${sourceId}`,
    );
    const existingByUrl = new Map(
      (
        existing.rows as {
          id: string;
          origin_url: string | null;
          content_hash: string;
        }[]
      )
        .filter((r) => r.origin_url !== null)
        .map((r) => [r.origin_url as string, r]),
    );

    const seenUrls = new Set<string>();
    for (const raw of raws) {
      const url = raw.originUrl;
      // Should not happen (every website RawDocument carries an originUrl),
      // but skip defensively rather than upserting under a null key that
      // would collide with every other null-origin_url row.
      if (!url) continue;
      seenUrls.add(url);

      const language = raw.language ?? 'nl';
      const contentHash = docHash(raw);
      const prior = existingByUrl.get(url);

      if (prior && prior.content_hash === contentHash) {
        continue; // Unchanged — skip re-chunk/re-embed entirely.
      }

      if (prior) {
        // Changed — replace this page's chunks and refresh its hash, but
        // keep the same document id/row (so unrelated references, e.g. in
        // chat citations, keep working).
        await db.execute(sql`DELETE FROM chunks WHERE document_id=${prior.id}`);
        await db.execute(
          sql`UPDATE documents SET title=${raw.title}, content_hash=${contentHash}, language=${language}, status='processing', updated_at=now() WHERE id=${prior.id}`,
        );
        await this.writeChunksForDocument(
          db,
          prior.id,
          projectId,
          raw,
          language,
          deduper,
        );
        continue;
      }

      // New page — insert and embed.
      await this.ingestDocument(db, sourceId, projectId, raw, deduper);
    }

    // Pages no longer present in this crawl: delete their document (chunks
    // cascade via the FK).
    const staleUrls = [...existingByUrl.keys()].filter(
      (url) => !seenUrls.has(url),
    );
    for (const url of staleUrls) {
      const stale = existingByUrl.get(url);
      if (!stale) continue;
      await db.execute(sql`DELETE FROM documents WHERE id=${stale.id}`);
    }
  }
}
