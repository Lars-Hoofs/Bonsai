import { Inject, Injectable, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { TenantDbService } from '../tenancy/tenant-db.service';
import { EMBEDDING_PROVIDER } from '../knowledge/embedding/embedding-provider';
import type { EmbeddingProvider } from '../knowledge/embedding/embedding-provider';
import { NoopRerankProvider, RERANK_PROVIDER } from './rerank-provider';
import type { RerankProvider } from './rerank-provider';

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
    @Optional()
    @Inject(RERANK_PROVIDER)
    private readonly reranker: RerankProvider = new NoopRerankProvider(),
  ) {}

  /**
   * Single-query retrieval. Thin wrapper over `retrieveMulti` with a
   * one-element query array — behavior is identical to before
   * `retrieveMulti` existed (see its doc comment for the general algorithm).
   */
  async retrieve(
    schemaName: string,
    projectId: string,
    query: string,
    options: RetrieveOptions = {},
  ): Promise<RetrievedChunk[]> {
    return this.retrieveMulti(schemaName, projectId, [query], options);
  }

  /**
   * Multi-query retrieval: runs the hybrid (pgvector + FTS) candidate query
   * independently for each entry in `queries`, then fuses the per-query
   * candidate lists with Reciprocal Rank Fusion (RRF) across queries —
   * a chunk's fused score is the sum, over every query where it appeared, of
   * `1 / (RRF_K + rankInThatQuery)`. This is on top of the existing
   * intra-query vector/FTS RRF fusion in `fetchCandidates`. Chunks are
   * deduped by chunkId, keeping the max `similarity` seen across queries
   * (that value drives the downstream confidence gate). The fused pool is
   * then reranked against `queries[0]` (the primary/original query) and the
   * top-k is returned — same reranking step as single-query retrieval.
   *
   * For a single-element `queries` array this is behaviorally identical to
   * the pre-multi-query `retrieve()`: fusing one query's ranked candidates
   * with the cross-query RRF formula reproduces the same order and score as
   * that query's own intra-query fused score (rank i -> 1/(RRF_K+i), summed
   * once), and the rerank step is unchanged.
   */
  async retrieveMulti(
    schemaName: string,
    projectId: string,
    queries: string[],
    options: RetrieveOptions = {},
  ): Promise<RetrievedChunk[]> {
    const topK = options.topK ?? 6;
    // Fetch a larger pool by RRF, then let the reranker pick the final top-k.
    const pool = Math.max(topK * 3, 20);
    const candidates = Math.max(topK * 4, 20);
    const language = options.language ?? 'nl';
    const k = RetrievalService.RRF_K;

    const perQueryResults = await Promise.all(
      queries.map((query) =>
        this.fetchCandidates(
          schemaName,
          projectId,
          query,
          language,
          candidates,
        ),
      ),
    );

    // Cross-query RRF fusion: sum 1/(k + rank) for each chunk over every
    // query's ranked candidate list (candidates are already ordered by each
    // query's own intra-query fused score, so index == rank there).
    const fused = new Map<string, RetrievedChunk & { fusedScore: number }>();
    for (const rows of perQueryResults) {
      rows.forEach((row, idx) => {
        const rank = idx + 1;
        const contribution = 1 / (k + rank);
        const existing = fused.get(row.chunkId);
        if (existing) {
          existing.fusedScore += contribution;
          existing.similarity = Math.max(existing.similarity, row.similarity);
        } else {
          fused.set(row.chunkId, { ...row, fusedScore: contribution });
        }
      });
    }
    if (fused.size === 0) return [];

    const mapped = [...fused.values()]
      .sort((a, b) => b.fusedScore - a.fusedScore)
      .slice(0, pool)
      .map(({ fusedScore, ...rest }) => ({ ...rest, score: fusedScore }));

    // Rerank the fused pool against the primary (first) query for precision;
    // the reranker score takes precedence, with the fused RRF score as a
    // stable tie-break. NoopReranker leaves RRF order intact.
    const primaryQuery = queries[0];
    const rerankScores = await this.reranker.rerank(
      primaryQuery,
      mapped.map((m) => m.text),
    );
    const ranked = mapped
      .map((m, i) => ({ m, rr: rerankScores[i] ?? 0 }))
      .sort((a, b) => b.rr - a.rr || b.m.score - a.m.score)
      .slice(0, topK)
      .map((x) => x.m);
    return ranked;
  }

  /**
   * Runs the hybrid (pgvector cosine + Postgres full-text) candidate query
   * for a single query string, returning candidates already ordered by their
   * intra-query RRF-fused score (index 0 = best match for this query).
   */
  private async fetchCandidates(
    schemaName: string,
    projectId: string,
    query: string,
    language: string,
    candidates: number,
  ): Promise<RetrievedChunk[]> {
    const cfg = regconfig(language);
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
        LIMIT ${candidates}
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
