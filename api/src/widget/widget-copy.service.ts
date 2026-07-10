import { Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { TenantDbService } from '../tenancy/tenant-db.service';
import { assertCopyShape, normalizeLocale } from './copy-validation';
import {
  DEFAULT_WIDGET_COPY,
  DEFAULT_WIDGET_COPY_LOCALE,
} from './default-copy';
import { negotiateCopy, parseAcceptLanguage } from './locale-negotiation';

export interface WidgetCopyView {
  projectId: string;
  defaultLocale: string;
  draft: Record<string, Record<string, string>>;
  published: Record<string, Record<string, string>> | null;
  publishedVersion: number;
  updatedAt: string;
}

export interface SaveCopyInput {
  copy?: Record<string, unknown>;
  defaultLocale?: string;
}

@Injectable()
export class WidgetCopyService {
  constructor(private readonly tenantDb: TenantDbService) {}

  /** Returns the copy config, creating it with Bonsai defaults on first access. */
  async get(schemaName: string, projectId: string): Promise<WidgetCopyView> {
    const row = await this.tenantDb.withTenant(schemaName, async (db) => {
      await db.execute(
        sql`INSERT INTO widget_copy (project_id, default_locale, draft)
            VALUES (
              ${projectId},
              ${DEFAULT_WIDGET_COPY_LOCALE},
              ${JSON.stringify(DEFAULT_WIDGET_COPY)}::jsonb
            )
            ON CONFLICT (project_id) DO NOTHING`,
      );
      const r = await db.execute(
        sql`SELECT * FROM widget_copy WHERE project_id=${projectId}`,
      );
      return r.rows[0];
    });
    return this.map(row);
  }

  /**
   * Updates the draft copy and/or the default locale. Both fields are
   * optional so an editor can change just the default locale, or just the
   * copy. The copy is validated and locale keys normalized before persisting.
   */
  async saveDraft(
    schemaName: string,
    projectId: string,
    input: SaveCopyInput,
  ): Promise<WidgetCopyView> {
    await this.get(schemaName, projectId); // ensure row exists
    const current = await this.get(schemaName, projectId);

    const draft =
      input.copy !== undefined ? assertCopyShape(input.copy) : current.draft;
    const defaultLocale =
      input.defaultLocale !== undefined
        ? normalizeLocale(input.defaultLocale)
        : current.defaultLocale;

    const row = await this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`UPDATE widget_copy
            SET draft=${JSON.stringify(draft)}::jsonb,
                default_locale=${defaultLocale},
                updated_at=now()
            WHERE project_id=${projectId} RETURNING *`,
      );
      return r.rows[0];
    });
    return this.map(row);
  }

  /** Copies the current draft copy to published and bumps the version. */
  async publish(
    schemaName: string,
    projectId: string,
  ): Promise<WidgetCopyView> {
    const current = await this.get(schemaName, projectId);
    // Defense in depth: re-validate the stored draft before promoting it to
    // the live, publicly-served copy, in case it was persisted before this
    // guard existed (or written directly to the DB).
    assertCopyShape(current.draft);
    const row = await this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`UPDATE widget_copy
            SET published=draft, published_version=published_version + 1, updated_at=now()
            WHERE project_id=${projectId} RETURNING *`,
      );
      return r.rows[0];
    });
    return this.map(row);
  }

  /**
   * Resolves the published copy for a requested/negotiated locale. `locale`
   * is an explicit `?locale=` value (validated, may be undefined), and
   * `acceptLanguage` is the raw `Accept-Language` header used as a fallback
   * preference list. Returns the chosen locale, the project's default locale,
   * and the copy map for the chosen locale. 404 until first publish.
   */
  async getPublishedCopy(
    schemaName: string,
    projectId: string,
    locale: string | undefined,
    acceptLanguage: string | undefined,
  ): Promise<{
    version: number;
    locale: string;
    defaultLocale: string;
    copy: Record<string, string>;
  }> {
    const view = await this.get(schemaName, projectId);
    if (!view.published) {
      throw new NotFoundException('Widget copy has not been published yet');
    }

    const requested: string[] = [];
    if (locale !== undefined) requested.push(normalizeLocale(locale));
    requested.push(...parseAcceptLanguage(acceptLanguage));

    const negotiated = negotiateCopy(
      view.published,
      requested,
      view.defaultLocale,
    );
    if (!negotiated) {
      throw new NotFoundException('Widget copy has no locales published');
    }
    return {
      version: view.publishedVersion,
      locale: negotiated.locale,
      defaultLocale: view.defaultLocale,
      copy: negotiated.copy,
    };
  }

  private map(row: Record<string, unknown>): WidgetCopyView {
    return {
      projectId: row.project_id as string,
      defaultLocale: (row.default_locale as string) ?? 'en',
      draft: (row.draft as Record<string, Record<string, string>>) ?? {},
      published:
        (row.published as Record<string, Record<string, string>> | null) ??
        null,
      publishedVersion: Number(row.published_version ?? 0),
      updatedAt: String(row.updated_at),
    };
  }
}
