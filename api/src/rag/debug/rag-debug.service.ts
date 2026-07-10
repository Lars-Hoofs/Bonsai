import {
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { TenantDbService } from '../../tenancy/tenant-db.service';
import { APP_CONFIG } from '../../config/config';
import type { AppConfig } from '../../config/config';
import { RetrievalService } from '../retrieval.service';
import { SynonymsService } from '../../synonyms/synonyms.service';

const PREVIEW_LENGTH = 200;
const DEFAULT_TOP_K = 6;

export interface DebugRetrievedChunk {
  /** 1-based position in the returned (score-ordered) list — matches the
   * citation index `AnswerService` would assign this chunk in `[n]`. */
  index: number;
  chunkId: string;
  documentId: string;
  documentTitle: string;
  sourceId: string;
  originUrl: string | null;
  /** Fused RRF score (post-rerank order, pre-rerank-score tie-break) — see
   * RetrievalService.retrieveMulti. */
  score: number;
  /** Raw cosine similarity (0..1) of this chunk to the query. */
  similarity: number;
  /** First ~200 chars of the matched (small) chunk text, for a quick look
   * without dumping the full chunk. */
  preview: string;
  ordinal: number;
}

export interface DebugRetrieveResult {
  question: string;
  language: string;
  /** topK actually requested from RetrievalService (request override or the
   * project/service default). */
  effectiveTopK: number;
  /** True when a real (non-Noop) rerank provider is configured, i.e. the
   * returned order/score reflects cross-encoder reranking rather than plain
   * RRF fusion order. */
  rerankingApplied: boolean;
  /** True when the project has >=1 synonym registered whose term appears (as
   * a whole word) in `question`, i.e. the lexical (FTS) side of retrieval was
   * widened with alias terms for this query. */
  synonymsApplied: boolean;
  chunks: DebugRetrievedChunk[];
}

/**
 * Retrieval-only debug/explainability service (#26): runs the SAME
 * `RetrievalService.retrieve` used by the real answer pipeline (respecting
 * the project's configured language), but returns the raw retrieved chunks
 * with their scores/similarity/preview instead of ever calling the LLM. Never
 * mutates state and has no effect on `AnswerService`/the `/answer` endpoint.
 */
@Injectable()
export class RagDebugService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly retrieval: RetrievalService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Optional() private readonly synonyms?: SynonymsService,
  ) {}

  async retrieve(
    schemaName: string,
    projectId: string,
    question: string,
    topK?: number,
  ): Promise<DebugRetrieveResult> {
    const project = await this.loadProject(schemaName, projectId);
    const effectiveTopK = topK ?? DEFAULT_TOP_K;

    const [chunks, synonymsApplied] = await Promise.all([
      this.retrieval.retrieve(schemaName, projectId, question, {
        topK: effectiveTopK,
        language: project.language,
      }),
      this.synonymsApplied(schemaName, projectId, question),
    ]);

    return {
      question,
      language: project.language,
      effectiveTopK,
      rerankingApplied: Boolean(
        this.cfg.rerankApiUrl && this.cfg.rerankApiKey && this.cfg.rerankModel,
      ),
      synonymsApplied,
      chunks: chunks.map((c, i) => ({
        index: i + 1,
        chunkId: c.chunkId,
        documentId: c.documentId,
        documentTitle: c.documentTitle,
        sourceId: c.sourceId,
        originUrl: c.originUrl,
        score: c.score,
        similarity: c.similarity,
        preview: c.text.slice(0, PREVIEW_LENGTH),
        ordinal: c.ordinal,
      })),
    };
  }

  /** True if the project has >=1 synonym whose term expands `question`'s
   * lexical query (see SynonymsService.expandQuery). Absent SynonymsService
   * (not wired) this is always false, mirroring RetrievalService's own
   * `@Optional` fallback. */
  private async synonymsApplied(
    schemaName: string,
    projectId: string,
    question: string,
  ): Promise<boolean> {
    if (!this.synonyms) return false;
    const expanded = await this.synonyms.expandQuery(
      schemaName,
      projectId,
      question,
    );
    return expanded !== question;
  }

  private async loadProject(
    schemaName: string,
    projectId: string,
  ): Promise<{ language: string }> {
    return this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`SELECT default_language FROM projects WHERE id = ${projectId}`,
      );
      const row = r.rows[0] as { default_language: string } | undefined;
      if (!row) {
        throw new NotFoundException('Project not found');
      }
      return { language: row.default_language ?? 'nl' };
    });
  }
}
