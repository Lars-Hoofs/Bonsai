import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { TenantDbService } from '../../tenancy/tenant-db.service';
import { ChunkingService } from '../chunking/chunking.service';
import { EMBEDDING_PROVIDER } from '../embedding/embedding-provider';
import type { EmbeddingProvider } from '../embedding/embedding-provider';
import { csvToDocuments, RawDocument } from './csv';
import { extractTitle, htmlToText } from './extract-text';
import { safeFetch } from '../../common/safe-fetch';

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

@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);

  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly chunking: ChunkingService,
    @Inject(EMBEDDING_PROVIDER) private readonly embedder: EmbeddingProvider,
  ) {}

  /**
   * (Re)ingests a source: extracts raw documents from its config, then for each
   * document chunks -> embeds -> indexes, replacing any prior chunks. Sets
   * source/document status transitions and records errors. Idempotent.
   */
  async ingestSource(schemaName: string, sourceId: string): Promise<void> {
    try {
      await this.tenantDb.withTenant(schemaName, async (db) => {
        const src = await this.loadSource(db, sourceId);
        await db.execute(
          sql`UPDATE knowledge_sources SET status='processing', error_detail=NULL, updated_at=now() WHERE id=${sourceId}`,
        );
        const raws = await this.extract(src.type, src.config);

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
          await this.ingestDocument(db, sourceId, src.projectId, raw);
        }
        await db.execute(
          sql`UPDATE knowledge_sources SET status='processed', last_synced_at=now(), updated_at=now() WHERE id=${sourceId}`,
        );
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.error(`Ingestion failed for source ${sourceId}: ${detail}`);
      await this.tenantDb.withTenant(schemaName, (db) =>
        db.execute(
          sql`UPDATE knowledge_sources SET status='failed', error_detail=${detail}, updated_at=now() WHERE id=${sourceId}`,
        ),
      );
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
  }> {
    const r = await db.execute(
      sql`SELECT type, project_id, config FROM knowledge_sources WHERE id=${sourceId}`,
    );
    const row = r.rows[0] as
      | { type: string; project_id: string; config: Record<string, unknown> }
      | undefined;
    if (!row) throw new Error(`Source ${sourceId} not found`);
    return { type: row.type, projectId: row.project_id, config: row.config };
  }

  private async extract(
    type: string,
    config: Record<string, unknown>,
  ): Promise<RawDocument[]> {
    const str = (v: unknown, fallback = ''): string =>
      typeof v === 'string' ? v : fallback;
    // 'upload' arrives with text already extracted by the controller, so it is
    // treated like a manual document here.
    if (type === 'manual' || type === 'upload') {
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
      let res: { status: number; body: string };
      try {
        res = await safeFetch(url, { maxBytes: 5_000_000 });
      } catch {
        // Generic message: the raw error (connection refused, DNS failure,
        // "Blocked URL", etc.) must not leak to the tenant, or it becomes an
        // oracle for scanning our internal network.
        throw new Error('Kon de opgegeven URL niet ophalen');
      }
      if (res.status < 200 || res.status >= 300) {
        throw new Error('Kon de opgegeven URL niet ophalen');
      }
      const html = res.body;
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
  ): Promise<void> {
    const language = raw.language ?? 'nl';
    const contentHash = docHash(raw);

    const inserted = await db.execute(
      sql`INSERT INTO documents (source_id, project_id, title, origin_url, content_hash, language, status)
          VALUES (${sourceId}, ${projectId}, ${raw.title}, ${raw.originUrl ?? null}, ${contentHash}, ${language}, 'processing')
          RETURNING id`,
    );
    const documentId = (inserted.rows[0] as { id: string }).id;

    const chunks = this.chunking.chunk(raw.body);
    if (chunks.length === 0) {
      await db.execute(
        sql`UPDATE documents SET status='processed', updated_at=now() WHERE id=${documentId}`,
      );
      return;
    }

    const vectors = await this.embedder.embed(chunks.map((c) => c.text));
    const cfg = regconfig(language);
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const vec = toVectorLiteral(vectors[i]);
      await db.execute(
        sql`INSERT INTO chunks (document_id, project_id, ordinal, text, token_count, section, embedding, tsv)
            VALUES (${documentId}, ${projectId}, ${c.ordinal}, ${c.text}, ${c.tokenCount}, ${c.section ?? null},
                    ${vec}::shared.vector, to_tsvector(${cfg}::regconfig, ${c.text}))`,
      );
    }
    await db.execute(
      sql`UPDATE documents SET status='processed', updated_at=now() WHERE id=${documentId}`,
    );
  }
}
