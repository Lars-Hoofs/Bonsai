import { Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { TenantDbService } from '../tenancy/tenant-db.service';
import { DEFAULT_WIDGET_THEME } from './default-theme';

export interface WidgetConfigView {
  projectId: string;
  draft: Record<string, unknown>;
  published: Record<string, unknown> | null;
  publishedVersion: number;
  updatedAt: string;
}

@Injectable()
export class WidgetService {
  constructor(private readonly tenantDb: TenantDbService) {}

  /** Returns the config, creating it with the Bonsai default draft on first access. */
  async get(schemaName: string, projectId: string): Promise<WidgetConfigView> {
    const row = await this.tenantDb.withTenant(schemaName, async (db) => {
      await db.execute(
        sql`INSERT INTO widget_configs (project_id, draft)
            VALUES (${projectId}, ${JSON.stringify(DEFAULT_WIDGET_THEME)}::jsonb)
            ON CONFLICT (project_id) DO NOTHING`,
      );
      const r = await db.execute(
        sql`SELECT * FROM widget_configs WHERE project_id=${projectId}`,
      );
      return r.rows[0];
    });
    return this.map(row);
  }

  async saveDraft(
    schemaName: string,
    projectId: string,
    draft: Record<string, unknown>,
  ): Promise<WidgetConfigView> {
    await this.get(schemaName, projectId); // ensure row exists
    const row = await this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`UPDATE widget_configs SET draft=${JSON.stringify(draft)}::jsonb, updated_at=now()
            WHERE project_id=${projectId} RETURNING *`,
      );
      return r.rows[0];
    });
    return this.map(row);
  }

  /** Copies the current draft to published and bumps the version. */
  async publish(
    schemaName: string,
    projectId: string,
  ): Promise<WidgetConfigView> {
    await this.get(schemaName, projectId);
    const row = await this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`UPDATE widget_configs
            SET published=draft, published_version=published_version + 1, updated_at=now()
            WHERE project_id=${projectId} RETURNING *`,
      );
      return r.rows[0];
    });
    return this.map(row);
  }

  /** The live theme served to the widget. 404 until first publish. */
  async getPublished(
    schemaName: string,
    projectId: string,
  ): Promise<{ version: number; theme: Record<string, unknown> }> {
    const view = await this.get(schemaName, projectId);
    if (!view.published) {
      throw new NotFoundException('Widget theme has not been published yet');
    }
    return { version: view.publishedVersion, theme: view.published };
  }

  private map(row: Record<string, unknown>): WidgetConfigView {
    return {
      projectId: row.project_id as string,
      draft: (row.draft as Record<string, unknown>) ?? {},
      published: (row.published as Record<string, unknown> | null) ?? null,
      publishedVersion: Number(row.published_version ?? 0),
      updatedAt: String(row.updated_at),
    };
  }
}
