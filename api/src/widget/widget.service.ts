import { Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { TenantDbService } from '../tenancy/tenant-db.service';
import { DEFAULT_WIDGET_THEME } from './default-theme';
import { assertThemeShape } from './theme-validation';
import {
  DEFAULT_TARGETING,
  DEFAULT_TRIGGERS,
  sanitizeTargeting,
  sanitizeTriggers,
  type TargetingConfig,
  type TriggersConfig,
} from './behavior-validation';

export interface WidgetConfigView {
  projectId: string;
  draft: Record<string, unknown>;
  published: Record<string, unknown> | null;
  publishedVersion: number;
  /** Page-targeting rules (#11) — draft is editor-visible, published is live. */
  targeting: {
    draft: TargetingConfig;
    published: TargetingConfig | null;
  };
  /** Proactive triggers (#12) — draft is editor-visible, published is live. */
  triggers: {
    draft: TriggersConfig;
    published: TriggersConfig | null;
  };
  updatedAt: string;
}

/** The read-only, sanitized config the public widget endpoint returns. */
export interface PublicWidgetConfig {
  version: number;
  theme: Record<string, unknown>;
  targeting: TargetingConfig;
  triggers: TriggersConfig;
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
    assertThemeShape(draft);
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

  /** Persists the page-targeting rules (#11) draft after sanitizing them. */
  async saveTargeting(
    schemaName: string,
    projectId: string,
    targeting: unknown,
  ): Promise<WidgetConfigView> {
    const clean = sanitizeTargeting(targeting);
    await this.get(schemaName, projectId); // ensure row exists
    const row = await this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`UPDATE widget_configs
            SET targeting_draft=${JSON.stringify(clean)}::jsonb, updated_at=now()
            WHERE project_id=${projectId} RETURNING *`,
      );
      return r.rows[0];
    });
    return this.map(row);
  }

  /** Persists the proactive-triggers (#12) draft after sanitizing them. */
  async saveTriggers(
    schemaName: string,
    projectId: string,
    triggers: unknown,
  ): Promise<WidgetConfigView> {
    const clean = sanitizeTriggers(triggers);
    await this.get(schemaName, projectId); // ensure row exists
    const row = await this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`UPDATE widget_configs
            SET triggers_draft=${JSON.stringify(clean)}::jsonb, updated_at=now()
            WHERE project_id=${projectId} RETURNING *`,
      );
      return r.rows[0];
    });
    return this.map(row);
  }

  /**
   * Copies the current draft to published and bumps the version. Theme,
   * page-targeting rules and proactive triggers are promoted together so the
   * live widget always sees a consistent snapshot of the whole config.
   */
  async publish(
    schemaName: string,
    projectId: string,
  ): Promise<WidgetConfigView> {
    const current = await this.get(schemaName, projectId);
    // Defense in depth: re-validate the stored drafts before copying them to
    // published, in case they were persisted before these guards existed (or
    // written directly to the DB) — publish must never promote an oversized/
    // malformed blob to the live, publicly-served config.
    assertThemeShape(current.draft);
    sanitizeTargeting(current.targeting.draft);
    sanitizeTriggers(current.triggers.draft);
    const row = await this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`UPDATE widget_configs
            SET published=draft,
                targeting_published=targeting_draft,
                triggers_published=triggers_draft,
                published_version=published_version + 1,
                updated_at=now()
            WHERE project_id=${projectId} RETURNING *`,
      );
      return r.rows[0];
    });
    return this.map(row);
  }

  /**
   * The live config served to the widget. 404 until first publish. Includes the
   * published theme plus the sanitized page-targeting rules and proactive
   * triggers the embed client acts on.
   */
  async getPublished(
    schemaName: string,
    projectId: string,
  ): Promise<PublicWidgetConfig> {
    const view = await this.get(schemaName, projectId);
    if (!view.published) {
      throw new NotFoundException('Widget theme has not been published yet');
    }
    // Sanitize on the way out too, so a directly-written DB row can never leak
    // an arbitrary/unsafe shape to the public endpoint.
    return {
      version: view.publishedVersion,
      theme: view.published,
      targeting: sanitizeTargeting(view.targeting.published),
      triggers: sanitizeTriggers(view.triggers.published),
    };
  }

  private map(row: Record<string, unknown>): WidgetConfigView {
    return {
      projectId: row.project_id as string,
      draft: (row.draft as Record<string, unknown>) ?? {},
      published: (row.published as Record<string, unknown> | null) ?? null,
      publishedVersion: Number(row.published_version ?? 0),
      targeting: {
        draft: row.targeting_draft
          ? sanitizeTargeting(row.targeting_draft)
          : { ...DEFAULT_TARGETING },
        published: row.targeting_published
          ? sanitizeTargeting(row.targeting_published)
          : null,
      },
      triggers: {
        draft: row.triggers_draft
          ? sanitizeTriggers(row.triggers_draft)
          : { ...DEFAULT_TRIGGERS },
        published: row.triggers_published
          ? sanitizeTriggers(row.triggers_published)
          : null,
      },
      updatedAt: String(row.updated_at),
    };
  }
}
