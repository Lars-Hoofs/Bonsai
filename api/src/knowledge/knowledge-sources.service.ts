import { Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { TenantDbService } from '../tenancy/tenant-db.service';
import { IngestionService } from './ingestion/ingestion.service';
import { validateSourceConfig } from './source-config-validation';

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
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly ingestion: IngestionService,
    private readonly audit: AuditService,
  ) {}

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
    await this.ingestion.ingestSource(tenant.schemaName, id);
    await this.audit.record({
      tenantId: tenant.id,
      actorUserId,
      action: 'knowledge_source.created',
      resource: `knowledge_source:${id}`,
      metadata: { type: input.type },
    });
    return this.get(tenant.schemaName, projectId, id);
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

  /** Re-runs ingestion for an existing source. */
  async reprocess(
    schemaName: string,
    projectId: string,
    id: string,
  ): Promise<SourceRow> {
    await this.get(schemaName, projectId, id); // 404 if not in this project
    await this.ingestion.ingestSource(schemaName, id);
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
