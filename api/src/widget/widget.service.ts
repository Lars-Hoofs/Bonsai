import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { TenantDbService } from '../tenancy/tenant-db.service';
import { checkContrast, isValidHexColor } from './contrast';
import type { ContrastCheckResult } from './contrast';
import { DEFAULT_WIDGET_THEME } from './default-theme';
import { getPreset, listPresets } from './presets';
import type { PresetName } from './presets';
import { validateTheme } from './theme-schema';
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

/** Extends a config view with a non-blocking WCAG contrast warning, if any. */
export interface WidgetConfigViewWithWarnings extends WidgetConfigView {
  contrastWarnings: string[];
}

/**
 * Computes low-contrast warnings (text vs background) for a theme, using
 * `colors.text`/`colors.background` when present. Never throws — an absent
 * or invalid color pair simply yields no warning, since contrast is a
 * non-blocking UX signal, not a validation rule.
 */
function computeContrastWarnings(theme: Record<string, unknown>): string[] {
  const colors = theme.colors;
  if (typeof colors !== 'object' || colors === null || Array.isArray(colors)) {
    return [];
  }
  const { text, background } = colors as Record<string, unknown>;
  if (!isValidHexColor(text) || !isValidHexColor(background)) return [];
  const result = checkContrast(text, background);
  if (!result.passesAA) {
    return [
      `Low contrast: text on background is ${result.ratio}:1, below the WCAG AA minimum of 4.5:1`,
    ];
  }
  return [];
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
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly audit: AuditService,
  ) {}

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
  ): Promise<WidgetConfigViewWithWarnings> {
    validateTheme(draft);
    await this.get(schemaName, projectId); // ensure row exists
    const row = await this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`UPDATE widget_configs SET draft=${JSON.stringify(draft)}::jsonb, updated_at=now()
            WHERE project_id=${projectId} RETURNING *`,
      );
      return r.rows[0];
    });
    const view = this.map(row);
    return { ...view, contrastWarnings: computeContrastWarnings(view.draft) };
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
    actor?: { tenantId?: string; actorUserId?: string },
  ): Promise<WidgetConfigViewWithWarnings> {
    const current = await this.get(schemaName, projectId);
    // Defense in depth: re-validate the stored drafts before copying them to
    // published, in case they were persisted before these guards existed (or
    // written directly to the DB) — publish must never promote an oversized/
    // malformed blob to the live, publicly-served config.
    validateTheme(current.draft);
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
    const view = this.map(row);
    await this.audit.record({
      tenantId: actor?.tenantId,
      actorUserId: actor?.actorUserId,
      action: 'widget.theme_published',
      resource: `widget_config:${projectId}`,
      metadata: { publishedVersion: view.publishedVersion },
    });
    return { ...view, contrastWarnings: computeContrastWarnings(view.draft) };
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

  /** The draft theme, for the shareable preview link (unauthenticated, token-gated). */
  async getDraftForPreview(
    schemaName: string,
    projectId: string,
  ): Promise<{ theme: Record<string, unknown> }> {
    const view = await this.get(schemaName, projectId);
    return { theme: view.draft };
  }

  listPresets(): ReturnType<typeof listPresets> {
    return listPresets();
  }

  /** Sets the draft to a built-in preset's theme wholesale. */
  async applyPreset(
    schemaName: string,
    projectId: string,
    presetName: string,
  ): Promise<WidgetConfigViewWithWarnings> {
    const preset = getPreset(presetName);
    if (!preset) {
      throw new BadRequestException(`Unknown preset: ${presetName}`);
    }
    return this.saveDraft(schemaName, projectId, preset.theme);
  }

  async exportTheme(
    schemaName: string,
    projectId: string,
  ): Promise<{ theme: Record<string, unknown> }> {
    const view = await this.get(schemaName, projectId);
    return { theme: view.draft };
  }

  async importTheme(
    schemaName: string,
    projectId: string,
    theme: Record<string, unknown>,
  ): Promise<WidgetConfigViewWithWarnings> {
    return this.saveDraft(schemaName, projectId, theme);
  }

  /** Computed contrast ratios for the current draft's text/background pair. */
  async contrastReport(
    schemaName: string,
    projectId: string,
  ): Promise<{
    text?: string;
    background?: string;
    result: ContrastCheckResult | null;
  }> {
    const view = await this.get(schemaName, projectId);
    const colors = view.draft.colors;
    const record =
      typeof colors === 'object' && colors !== null && !Array.isArray(colors)
        ? (colors as Record<string, unknown>)
        : {};
    const text = record.text;
    const background = record.background;
    if (!isValidHexColor(text) || !isValidHexColor(background)) {
      return { result: null };
    }
    return { text, background, result: checkContrast(text, background) };
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

export type { PresetName };
