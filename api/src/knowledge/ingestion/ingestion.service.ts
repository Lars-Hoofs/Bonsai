import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { TenantDbService } from '../../tenancy/tenant-db.service';
import { ChunkingService } from '../chunking/chunking.service';
import { EMBEDDING_PROVIDER } from '../embedding/embedding-provider';
import type { EmbeddingProvider } from '../embedding/embedding-provider';
import { csvToDocuments, RawDocument } from './csv';

/** Maps a document language to a Postgres text-search configuration. */
function regconfig(language: string): string {
  if (language.startsWith('nl')) return 'dutch';
  if (language.startsWith('en')) return 'english';
  return 'simple';
}

function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
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
        const raws = this.extract(src.type, src.config);
        // Replace prior documents for a clean reprocess.
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

  private extract(
    type: string,
    config: Record<string, unknown>,
  ): RawDocument[] {
    const str = (v: unknown, fallback = ''): string =>
      typeof v === 'string' ? v : fallback;
    if (type === 'manual') {
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
    throw new Error(`Unsupported source type for ingestion: ${type}`);
  }

  private async ingestDocument(
    db: NodePgDatabase,
    sourceId: string,
    projectId: string,
    raw: RawDocument,
  ): Promise<void> {
    const language = raw.language ?? 'nl';
    const contentHash = createHash('sha256')
      .update(`${raw.title}\n${raw.body}`)
      .digest('hex');

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
