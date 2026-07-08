import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { TenantDbService } from '../tenancy/tenant-db.service';
import { EMBEDDING_PROVIDER } from '../knowledge/embedding/embedding-provider';
import type { EmbeddingProvider } from '../knowledge/embedding/embedding-provider';

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  sourceId: string;
  documentTitle: string;
  originUrl: string | null;
  text: string;
  score: number;
  /** Raw cosine similarity (0..1) of this chunk to the query. Drives confidence. */
  similarity: number;
}

export interface RetrieveOptions {
  topK?: number;
  language?: string;
}

function regconfig(language: string): string {
  if (language.startsWith('nl')) return 'dutch';
  if (language.startsWith('en')) return 'english';
  return 'simple';
}

/**
 * Hybrid retrieval over a project's chunks: semantic (pgvector cosine) and
 * lexical (Postgres full-text) candidate lists are merged with Reciprocal Rank
 * Fusion (RRF). Lexical recall catches exact terms/product names that
 * embeddings miss; semantic recall catches paraphrases. Everything is scoped to
 * the tenant schema via withTenant and filtered by project_id.
 */
@Injectable()
export class RetrievalService {
  private static readonly RRF_K = 60;

  constructor(
    private readonly tenantDb: TenantDbService,
    @Inject(EMBEDDING_PROVIDER) private readonly embedder: EmbeddingProvider,
  ) {}

  async retrieve(
    schemaName: string,
    projectId: string,
    query: string,
    options: RetrieveOptions = {},
  ): Promise<RetrievedChunk[]> {
    const topK = options.topK ?? 6;
    const candidates = Math.max(topK * 4, 20);
    const cfg = regconfig(options.language ?? 'nl');
    const [queryVec] = await this.embedder.embed([query]);
    const vecLiteral = `[${queryVec.join(',')}]`;
    const k = RetrievalService.RRF_K;

    const rows = await this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(sql`
        WITH q AS (SELECT ${vecLiteral}::shared.vector AS v),
        vec AS (
          SELECT c.id,
                 row_number() OVER (ORDER BY c.embedding <=> (SELECT v FROM q)) AS rnk
          FROM chunks c
          WHERE c.project_id = ${projectId} AND c.embedding IS NOT NULL
          ORDER BY c.embedding <=> (SELECT v FROM q)
          LIMIT ${candidates}
        ),
        fts AS (
          SELECT c.id,
                 row_number() OVER (
                   ORDER BY ts_rank(c.tsv, plainto_tsquery(${cfg}::regconfig, ${query})) DESC
                 ) AS rnk
          FROM chunks c
          WHERE c.project_id = ${projectId}
            AND c.tsv @@ plainto_tsquery(${cfg}::regconfig, ${query})
          LIMIT ${candidates}
        )
        SELECT c.id AS chunk_id, c.document_id, c.text,
               d.title AS document_title, d.source_id, d.origin_url,
               1.0 - (c.embedding <=> (SELECT v FROM q)) AS similarity,
               COALESCE(1.0 / (${k} + vec.rnk), 0)
             + COALESCE(1.0 / (${k} + fts.rnk), 0) AS score
        FROM chunks c
        LEFT JOIN vec ON vec.id = c.id
        LEFT JOIN fts ON fts.id = c.id
        JOIN documents d ON d.id = c.document_id
        WHERE c.project_id = ${projectId}
          AND (vec.id IS NOT NULL OR fts.id IS NOT NULL)
        ORDER BY score DESC
        LIMIT ${topK}
      `);
      return r.rows;
    });

    return rows.map((row) => ({
      chunkId: row.chunk_id as string,
      documentId: row.document_id as string,
      sourceId: row.source_id as string,
      documentTitle: row.document_title as string,
      originUrl: (row.origin_url as string | null) ?? null,
      text: row.text as string,
      score: Number(row.score),
      similarity: Number(row.similarity),
    }));
  }
}
