import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { TenantDbService } from '../tenancy/tenant-db.service';
import { EMBEDDING_PROVIDER } from '../knowledge/embedding/embedding-provider';
import type { EmbeddingProvider } from '../knowledge/embedding/embedding-provider';

/** Rough token estimate matching ChunkingService's own heuristic:
 * whitespace-delimited words (~1 token/word for NL/EN). Re-embedding an
 * edited chunk needs a fresh token_count consistent with what ingestion
 * would have produced for the same text. */
function countTokens(text: string): number {
  const m = text.trim().match(/\S+/g);
  return m ? m.length : 0;
}

/** Maps a document language to a Postgres text-search configuration —
 * identical mapping to IngestionService/RetrievalService so an edited
 * chunk's tsv stays consistent with how the rest of the corpus was indexed. */
function regconfig(language: string): string {
  if (language.startsWith('nl')) return 'dutch';
  if (language.startsWith('en')) return 'english';
  return 'simple';
}

function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
}

const MAX_PREVIEW_CHARS = 200;

export interface ChunkListItem {
  id: string;
  documentId: string;
  documentTitle: string;
  ordinal: number;
  section: string | null;
  preview: string;
  tokenCount: number;
}

export interface ChunkDetail {
  id: string;
  documentId: string;
  documentTitle: string;
  ordinal: number;
  section: string | null;
  text: string;
  tokenCount: number;
  createdAt: string;
}

export interface ListChunksOptions {
  documentId?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function toIso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

function preview(text: string): string {
  return text.length > MAX_PREVIEW_CHARS
    ? `${text.slice(0, MAX_PREVIEW_CHARS)}…`
    : text;
}

/**
 * Chunk inspector: read/search/edit/delete individual knowledge chunks of a
 * project, for KB tuning/debugging. Editing a chunk's text re-embeds it (and
 * regenerates its tsvector) via the same EmbeddingProvider/regconfig
 * approach ingestion uses, so retrieval stays consistent with what an
 * editor sees here.
 */
@Injectable()
export class ChunksService {
  constructor(
    private readonly tenantDb: TenantDbService,
    @Inject(EMBEDDING_PROVIDER) private readonly embedder: EmbeddingProvider,
    private readonly audit: AuditService,
  ) {}

  async list(
    schemaName: string,
    projectId: string,
    options: ListChunksOptions = {},
  ): Promise<ChunkListItem[]> {
    const limit = Math.min(
      Math.max(options.limit ?? DEFAULT_LIMIT, 1),
      MAX_LIMIT,
    );
    const offset = Math.max(options.offset ?? 0, 0);
    const rows = await this.tenantDb.withTenant(schemaName, async (db) => {
      const documentFilter = options.documentId
        ? sql`AND c.document_id = ${options.documentId}`
        : sql``;
      const searchFilter = options.q
        ? sql`AND c.text ILIKE ${'%' + options.q + '%'}`
        : sql``;
      const r = await db.execute(sql`
        SELECT c.id, c.document_id, c.ordinal, c.section, c.text, c.token_count,
               d.title AS document_title
        FROM chunks c
        JOIN documents d ON d.id = c.document_id
        WHERE c.project_id = ${projectId}
          ${documentFilter}
          ${searchFilter}
        ORDER BY d.created_at, c.ordinal
        LIMIT ${limit} OFFSET ${offset}
      `);
      return r.rows;
    });
    return rows.map((row) => ({
      id: row.id as string,
      documentId: row.document_id as string,
      documentTitle: row.document_title as string,
      ordinal: Number(row.ordinal),
      section: (row.section as string | null) ?? null,
      preview: preview(row.text as string),
      tokenCount: Number(row.token_count),
    }));
  }

  async get(
    schemaName: string,
    projectId: string,
    chunkId: string,
  ): Promise<ChunkDetail> {
    const row = await this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(sql`
        SELECT c.id, c.document_id, c.ordinal, c.section, c.text, c.token_count, c.created_at,
               d.title AS document_title
        FROM chunks c
        JOIN documents d ON d.id = c.document_id
        WHERE c.id = ${chunkId} AND c.project_id = ${projectId}
      `);
      return r.rows[0];
    });
    if (!row) throw new NotFoundException('Chunk not found');
    return {
      id: row.id as string,
      documentId: row.document_id as string,
      documentTitle: row.document_title as string,
      ordinal: Number(row.ordinal),
      section: (row.section as string | null) ?? null,
      text: row.text as string,
      tokenCount: Number(row.token_count),
      createdAt: toIso(row.created_at),
    };
  }

  /**
   * Edits a chunk's text, re-embedding it and regenerating its tsvector +
   * token_count so retrieval (both vector and lexical) stays consistent with
   * what ingestion would have produced. Uses the owning document's language
   * for the tsvector regconfig, matching ingestion's own mapping.
   */
  async update(
    tenant: { id: string; schemaName: string },
    projectId: string,
    chunkId: string,
    text: string,
    actorUserId: string,
  ): Promise<ChunkDetail> {
    const vec = await this.embedder.embed([text]);
    const vecLiteral = toVectorLiteral(vec[0]);
    const tokenCount = countTokens(text);

    const updated = await this.tenantDb.withTenant(
      tenant.schemaName,
      async (db) => {
        const doc = await db.execute(sql`
          SELECT d.language
          FROM chunks c
          JOIN documents d ON d.id = c.document_id
          WHERE c.id = ${chunkId} AND c.project_id = ${projectId}
        `);
        const docRow = doc.rows[0] as { language: string } | undefined;
        if (!docRow) return false;
        const cfg = regconfig(docRow.language);
        const r = await db.execute(sql`
          UPDATE chunks
          SET text = ${text},
              token_count = ${tokenCount},
              embedding = ${vecLiteral}::shared.vector,
              tsv = to_tsvector(${cfg}::regconfig, ${text})
          WHERE id = ${chunkId} AND project_id = ${projectId}
          RETURNING id
        `);
        return r.rows.length > 0;
      },
    );
    if (!updated) throw new NotFoundException('Chunk not found');
    await this.audit.record({
      tenantId: tenant.id,
      actorUserId,
      action: 'chunk.updated',
      resource: `chunk:${chunkId}`,
    });
    return this.get(tenant.schemaName, projectId, chunkId);
  }

  async remove(
    tenant: { id: string; schemaName: string },
    projectId: string,
    chunkId: string,
    actorUserId: string,
  ): Promise<void> {
    const deleted = await this.tenantDb.withTenant(
      tenant.schemaName,
      async (db) => {
        const r = await db.execute(
          sql`DELETE FROM chunks WHERE id = ${chunkId} AND project_id = ${projectId} RETURNING id`,
        );
        return r.rows.length > 0;
      },
    );
    if (!deleted) throw new NotFoundException('Chunk not found');
    await this.audit.record({
      tenantId: tenant.id,
      actorUserId,
      action: 'chunk.deleted',
      resource: `chunk:${chunkId}`,
    });
  }
}
