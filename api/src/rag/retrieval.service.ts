import { Inject, Injectable, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { TenantDbService } from '../tenancy/tenant-db.service';
import { APP_CONFIG } from '../config/config';
import type { AppConfig } from '../config/config';
import { EMBEDDING_PROVIDER } from '../knowledge/embedding/embedding-provider';
import type { EmbeddingProvider } from '../knowledge/embedding/embedding-provider';
import { NoopRerankProvider, RERANK_PROVIDER } from './rerank-provider';
import type { RerankProvider } from './rerank-provider';
import { SynonymsService } from '../synonyms/synonyms.service';

/** Fallback used when RetrievalService is constructed directly (tests) without
 * an AppConfig — matches the config default (window=1). */
const DEFAULT_RETRIEVAL_WINDOW = 1;

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  sourceId: string;
  documentTitle: string;
  originUrl: string | null;
  /** Position of this chunk within its document (0-based). */
  ordinal: number;
  /** Text of ONLY the matched (small, embedded) chunk. Reranking/citation
   * identity are always based on this, never on `expandedText`. */
  text: string;
  /**
   * Parent-child context-window expansion (A6): `text` plus up to
   * `retrievalWindow` neighboring chunks (by `ordinal`) from the same
   * document, concatenated in ascending ordinal order (deduped, matched chunk
   * included). This is what should be sent to the LLM as context — it gives
   * more surrounding context than the small chunk that was actually matched
   * for precision. Equals `text` when `retrievalWindow` is 0 or no neighbors
   * exist.
   */
  expandedText: string;
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

  private readonly retrievalWindow: number;

  constructor(
    private readonly tenantDb: TenantDbService,
    @Inject(EMBEDDING_PROVIDER) private readonly embedder: EmbeddingProvider,
    @Optional()
    @Inject(RERANK_PROVIDER)
    private readonly reranker: RerankProvider = new NoopRerankProvider(),
    @Optional() @Inject(APP_CONFIG) cfg?: AppConfig,
    @Optional() private readonly synonyms?: SynonymsService,
  ) {
    this.retrievalWindow = cfg?.retrievalWindow ?? DEFAULT_RETRIEVAL_WINDOW;
  }

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

    // Parent-child context-window expansion (A6): reranking/top-k selection
    // above is already final and was based on the small matched `text`; this
    // only enriches `expandedText` on the selected chunks.
    return this.expandContext(schemaName, projectId, ranked);
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

    // Synonyms only ever WIDEN the lexical (FTS) query text — the vector
    // side above already embedded the original `query` unchanged, and stays
    // the single source of truth for semantic search. When no SynonymsService
    // is wired in (e.g. tests constructing RetrievalService directly) or a
    // project has no synonyms configured, `expandQuery` returns `query`
    // unchanged, so `ftsTsQuery` below reduces to plain `plainto_tsquery(query)`
    // — byte-for-byte identical to before this feature.
    //
    // `expandQuery` returns the original query text with matched synonyms'
    // aliases APPENDED (per its documented contract). Note `plainto_tsquery`
    // ANDs every lexeme together, so naively feeding the appended string
    // straight into a single `plainto_tsquery` would require the alias
    // word(s) to appear IN ADDITION TO every original query word in the same
    // chunk — the opposite of what a synonym boost should do. Instead we
    // extract just the appended alias suffix and OR its own
    // `plainto_tsquery` (via Postgres's `tsquery || tsquery`) alongside the
    // unmodified original query's `plainto_tsquery`: a chunk matches if it
    // has ALL the original query's words, OR the alias word(s) alone.
    const expanded = this.synonyms
      ? await this.synonyms.expandQuery(schemaName, projectId, query)
      : query;
    const aliasSuffix =
      expanded === query ? null : expanded.slice(query.length).trim();

    const rows = await this.tenantDb.withTenant(schemaName, async (db) => {
      const ftsTsQuery = aliasSuffix
        ? sql`(plainto_tsquery(${cfg}::regconfig, ${query}) || plainto_tsquery(${cfg}::regconfig, ${aliasSuffix}))`
        : sql`plainto_tsquery(${cfg}::regconfig, ${query})`;
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
                   ORDER BY ts_rank(c.tsv, ${ftsTsQuery}) DESC
                 ) AS rnk
          FROM chunks c
          WHERE c.project_id = ${projectId}
            AND c.tsv @@ ${ftsTsQuery}
          LIMIT ${candidates}
        )
        SELECT c.id AS chunk_id, c.document_id, c.ordinal, c.text,
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

    return rows.map((row) => {
      const text = row.text as string;
      return {
        chunkId: row.chunk_id as string,
        documentId: row.document_id as string,
        sourceId: row.source_id as string,
        documentTitle: row.document_title as string,
        originUrl: (row.origin_url as string | null) ?? null,
        ordinal: Number(row.ordinal),
        text,
        // Placeholder — filled in by `expandContext` once the final top-k is
        // selected in `retrieveMulti`. Defaulting to `text` here means any
        // code path that skips expansion (e.g. an empty fused pool) still
        // satisfies the "expandedText === text when no expansion" contract.
        expandedText: text,
        score: Number(row.score),
        similarity: Number(row.similarity),
      };
    });
  }

  /**
   * Parent-child context-window expansion (A6): for each of the final,
   * already-selected/reranked `chunks`, fetches sibling chunks from the same
   * document whose `ordinal` falls within
   * [selected.ordinal - retrievalWindow, selected.ordinal + retrievalWindow],
   * and sets `expandedText` to those neighbors' text (deduped, matched chunk
   * included) concatenated in ascending ordinal order. Runs as ONE additional
   * query covering all selected chunks/documents. A no-op (chunks returned
   * unchanged, `expandedText === text`) when the window is 0 or there are no
   * chunks to expand — this reproduces pre-A6 behavior exactly.
   *
   * Deliberately does NOT affect ranking: the reranker/top-k selection above
   * already happened against the small matched `text`; this only enriches
   * the context each selected chunk carries forward to the LLM.
   */
  private async expandContext(
    schemaName: string,
    projectId: string,
    chunks: RetrievedChunk[],
  ): Promise<RetrievedChunk[]> {
    if (this.retrievalWindow <= 0 || chunks.length === 0) return chunks;
    const window = this.retrievalWindow;

    const documentIds = [...new Set(chunks.map((c) => c.documentId))];
    const neighbors = await this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(sql`
        SELECT document_id, ordinal, text
        FROM chunks
        WHERE project_id = ${projectId}
          AND document_id IN (${sql.join(
            documentIds.map((id) => sql`${id}`),
            sql`, `,
          )})
        ORDER BY document_id, ordinal ASC
      `);
      return r.rows as { document_id: string; ordinal: number; text: string }[];
    });

    // Group neighbor rows by documentId for O(1) lookup per selected chunk.
    const byDocument = new Map<string, { ordinal: number; text: string }[]>();
    for (const row of neighbors) {
      const list = byDocument.get(row.document_id);
      const entry = { ordinal: Number(row.ordinal), text: row.text };
      if (list) {
        list.push(entry);
      } else {
        byDocument.set(row.document_id, [entry]);
      }
    }

    return chunks.map((c) => {
      const siblings = byDocument.get(c.documentId) ?? [];
      const inWindow = siblings
        .filter((s) => Math.abs(s.ordinal - c.ordinal) <= window)
        .sort((a, b) => a.ordinal - b.ordinal);
      const expandedText =
        inWindow.length > 0
          ? [
              ...new Map(inWindow.map((s) => [s.ordinal, s.text])).values(),
            ].join('\n\n')
          : c.text;
      return { ...c, expandedText };
    });
  }
}
