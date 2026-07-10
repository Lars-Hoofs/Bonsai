import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AuditService } from '../../audit/audit.service';
import { TenantDbService } from '../../tenancy/tenant-db.service';
import { KnowledgeSourcesService } from '../knowledge-sources.service';
import {
  BundleFormat,
  entriesToCsv,
  entriesToJson,
  entriesToMarkdownZip,
  KbEntry,
  parseBundle,
  RowError,
} from './bundle';

/** Upper bound on entries accepted in a single import, to keep one request's
 * ingestion cost bounded. */
export const MAX_IMPORT_ENTRIES = 5_000;

export interface ExportResult {
  filename: string;
  contentType: string;
  /** JSON/CSV bodies are strings; the Markdown-zip bundle is a Buffer. */
  body: string | Buffer;
}

export interface ImportSummary {
  imported: number;
  failed: number;
  errors: RowError[];
}

@Injectable()
export class KbBulkService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly knowledge: KnowledgeSourcesService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Reconstructs the project's manual KB as a flat list of entries. Body is
   * rebuilt from the stored chunks (ordered by ordinal), which works uniformly
   * across manual/upload/csv sources without depending on the raw source
   * config shape. Documents with zero chunks are skipped.
   */
  async collectEntries(
    schemaName: string,
    projectId: string,
  ): Promise<KbEntry[]> {
    return this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`SELECT d.id, d.title, d.language,
              string_agg(c.text, E'\n\n' ORDER BY c.ordinal) AS body
            FROM documents d
            JOIN knowledge_sources s ON s.id = d.source_id
            JOIN chunks c ON c.document_id = d.id
            WHERE d.project_id = ${projectId}
              AND s.type IN ('manual', 'upload', 'csv')
            GROUP BY d.id, d.title, d.language, d.created_at
            ORDER BY d.created_at, d.id`,
      );
      return (r.rows as { title: string; language: string; body: string }[])
        .filter((row) => (row.body ?? '').trim().length > 0)
        .map((row) => ({
          title: row.title,
          body: row.body,
          language: row.language,
        }));
    });
  }

  async export(
    tenant: { id: string; schemaName: string },
    projectId: string,
    format: BundleFormat,
    actorUserId: string,
  ): Promise<ExportResult> {
    const entries = await this.collectEntries(tenant.schemaName, projectId);
    await this.audit.record({
      tenantId: tenant.id,
      actorUserId,
      action: 'knowledge.exported',
      resource: `project:${projectId}`,
      metadata: { format, count: entries.length },
    });
    const stem = `knowledge-${projectId}`;
    if (format === 'csv') {
      return {
        filename: `${stem}.csv`,
        contentType: 'text/csv; charset=utf-8',
        body: entriesToCsv(entries),
      };
    }
    if (format === 'zip') {
      return {
        filename: `${stem}.zip`,
        contentType: 'application/zip',
        body: entriesToMarkdownZip(entries),
      };
    }
    return {
      filename: `${stem}.json`,
      contentType: 'application/json; charset=utf-8',
      body: entriesToJson(entries),
    };
  }

  /**
   * Bulk-imports a bundle: parses + per-row validates, then creates one
   * `manual` knowledge source per valid entry. Each created source is run
   * through the normal ingestion pipeline (chunk -> embed -> index) by
   * `KnowledgeSourcesService.create`, so imported entries become searchable
   * exactly like manually-added ones. Structural (parse-time) errors and any
   * per-entry ingestion failure are reported per row; valid rows still import.
   */
  async import(
    tenant: { id: string; schemaName: string },
    projectId: string,
    format: BundleFormat,
    data: Buffer,
    actorUserId: string,
  ): Promise<ImportSummary> {
    const parsed = parseBundle(format, data);
    const errors: RowError[] = [...parsed.errors];

    if (parsed.entries.length > MAX_IMPORT_ENTRIES) {
      throw new Error(
        `Bundle bevat te veel entries (max ${MAX_IMPORT_ENTRIES})`,
      );
    }

    let imported = 0;
    for (let i = 0; i < parsed.entries.length; i++) {
      const entry = parsed.entries[i];
      try {
        await this.knowledge.create(
          tenant,
          projectId,
          {
            type: 'manual',
            name: entry.title,
            config: {
              title: entry.title,
              body: entry.body,
              ...(entry.language ? { language: entry.language } : {}),
            },
          },
          actorUserId,
        );
        imported++;
      } catch (err) {
        errors.push({
          // Report against the entry's original position where determinable.
          row: i,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    await this.audit.record({
      tenantId: tenant.id,
      actorUserId,
      action: 'knowledge.imported',
      resource: `project:${projectId}`,
      metadata: { format, imported, failed: errors.length },
    });

    return { imported, failed: errors.length, errors };
  }
}
