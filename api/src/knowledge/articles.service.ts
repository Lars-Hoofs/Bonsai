import { Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { TenantDbService } from '../tenancy/tenant-db.service';
import { htmlToMarkdown } from './ingestion/html-to-markdown';
import type { CreateArticleDto } from './article.dto';
import { KnowledgeSourcesService } from './knowledge-sources.service';
import type { SourceRow } from './knowledge-sources.service';

/** The `article` source type reuses the knowledge ingestion pipeline: an
 * article's config carries a rendered Markdown `body` (see buildArticleConfig)
 * that `IngestionService.extract` turns into a single RawDocument, exactly like
 * a `manual`/`upload` source. Categories/tags are structured taxonomy stored
 * alongside for listing/filtering. */

export interface ArticleConfig {
  title: string;
  question: string | null;
  answer: string | null;
  /** Rendered Markdown that gets chunked + embedded. */
  body: string;
  /** Original rich-text (HTML) or Markdown as authored, for round-tripping
   * back into the editor. */
  sourceContent: string | null;
  contentFormat: 'html' | 'markdown' | null;
  categories: string[];
  tags: string[];
  language: string | null;
}

export interface ArticleRow extends SourceRow {
  title: string;
  question: string | null;
  answer: string | null;
  body: string;
  sourceContent: string | null;
  contentFormat: 'html' | 'markdown' | null;
  categories: string[];
  tags: string[];
  language: string | null;
}

/**
 * Builds the indexed Markdown body from the structured article fields. A Q&A
 * pair is rendered as a "## Question / answer" block so both the question
 * phrasing and the answer text are embedded (helps retrieval match on either);
 * free-form article content is appended below.
 */
export function buildArticleBody(input: {
  question?: string;
  answer?: string;
  markdown: string;
}): string {
  const parts: string[] = [];
  const q = input.question?.trim();
  const a = input.answer?.trim();
  if (q) parts.push(`## ${q}`);
  if (a) parts.push(a);
  const body = input.markdown.trim();
  if (body) parts.push(body);
  return parts.join('\n\n').trim();
}

/** Normalizes a raw DTO into the persisted `article` source config. */
export function buildArticleConfig(dto: CreateArticleDto): ArticleConfig {
  const format = dto.contentFormat ?? 'html';
  const rawContent = dto.content ?? '';
  const markdown =
    format === 'html' ? htmlToMarkdown(rawContent) : rawContent.trim();
  const body = buildArticleBody({
    question: dto.question,
    answer: dto.answer,
    markdown,
  });
  return {
    title: dto.title,
    question: dto.question?.trim() || null,
    answer: dto.answer?.trim() || null,
    body,
    sourceContent: rawContent ? rawContent : null,
    contentFormat: rawContent ? format : null,
    categories: dedupeTaxonomy(dto.categories),
    tags: dedupeTaxonomy(dto.tags),
    language: dto.language ?? null,
  };
}

function dedupeTaxonomy(values?: string[]): string[] {
  if (!values) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const t = v.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function mapArticle(base: SourceRow, config: ArticleConfig): ArticleRow {
  return {
    ...base,
    title: config.title,
    question: config.question,
    answer: config.answer,
    body: config.body,
    sourceContent: config.sourceContent,
    contentFormat: config.contentFormat,
    categories: config.categories ?? [],
    tags: config.tags ?? [],
    language: config.language,
  };
}

@Injectable()
export class ArticlesService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly sources: KnowledgeSourcesService,
    private readonly audit: AuditService,
  ) {}

  /** Creates an `article` knowledge source and ingests it (chunk + embed). */
  async create(
    tenant: { id: string; schemaName: string },
    projectId: string,
    dto: CreateArticleDto,
    actorUserId: string,
  ): Promise<ArticleRow> {
    const config = buildArticleConfig(dto);
    const source = await this.sources.create(
      tenant,
      projectId,
      {
        type: 'article',
        name: config.title,
        config: config as unknown as Record<string, unknown>,
      },
      actorUserId,
    );
    await this.syncTaxonomyColumns(
      tenant.schemaName,
      projectId,
      source.id,
      config,
    );
    return this.get(tenant.schemaName, projectId, source.id);
  }

  /**
   * Edits an existing article in place and re-ingests it. Unlike other source
   * types (create-only), articles are editable — that is the point of the
   * editor. Re-uses the ingestion pipeline via `reprocess`, which re-chunks and
   * re-embeds only when the content actually changed.
   */
  async update(
    tenant: { id: string; schemaName: string },
    projectId: string,
    sourceId: string,
    dto: CreateArticleDto,
    actorUserId: string,
  ): Promise<ArticleRow> {
    await this.get(tenant.schemaName, projectId, sourceId); // 404 if missing
    const config = buildArticleConfig(dto);
    const updated = await this.tenantDb.withTenant(
      tenant.schemaName,
      async (db) => {
        const r = await db.execute(
          sql`UPDATE knowledge_sources
              SET name=${config.title},
                  config=${JSON.stringify(config)}::jsonb,
                  categories=${sql.param(config.categories)}::text[],
                  tags=${sql.param(config.tags)}::text[],
                  updated_at=now()
              WHERE id=${sourceId} AND project_id=${projectId} AND type='article'
              RETURNING id`,
        );
        return r.rows.length > 0;
      },
    );
    if (!updated) throw new NotFoundException('Article not found');
    await this.audit.record({
      tenantId: tenant.id,
      actorUserId,
      action: 'knowledge_article.updated',
      resource: `knowledge_source:${sourceId}`,
    });
    // Re-chunk + re-embed the new content.
    await this.sources.reprocess(tenant.schemaName, projectId, sourceId);
    return this.get(tenant.schemaName, projectId, sourceId);
  }

  /** Mirrors the article's categories/tags into the denormalised columns used
   * for listing/filtering (config remains the source of truth). */
  private async syncTaxonomyColumns(
    schemaName: string,
    projectId: string,
    sourceId: string,
    config: ArticleConfig,
  ): Promise<void> {
    await this.tenantDb.withTenant(schemaName, async (db) => {
      await db.execute(
        sql`UPDATE knowledge_sources
            SET categories=${sql.param(config.categories)}::text[],
                tags=${sql.param(config.tags)}::text[]
            WHERE id=${sourceId} AND project_id=${projectId} AND type='article'`,
      );
    });
  }

  async list(schemaName: string, projectId: string): Promise<ArticleRow[]> {
    const rows = await this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`SELECT * FROM knowledge_sources
            WHERE project_id=${projectId} AND type='article'
            ORDER BY created_at`,
      );
      return r.rows;
    });
    return rows.map((row) => {
      const base = this.sources.mapSourceRow(row);
      return mapArticle(base, row.config as ArticleConfig);
    });
  }

  async get(
    schemaName: string,
    projectId: string,
    sourceId: string,
  ): Promise<ArticleRow> {
    const row = await this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`SELECT * FROM knowledge_sources
            WHERE id=${sourceId} AND project_id=${projectId} AND type='article'`,
      );
      return r.rows[0];
    });
    if (!row) throw new NotFoundException('Article not found');
    const base = this.sources.mapSourceRow(row);
    return mapArticle(base, row.config as ArticleConfig);
  }

  async remove(
    tenant: { id: string; schemaName: string },
    projectId: string,
    sourceId: string,
    actorUserId: string,
  ): Promise<void> {
    await this.get(tenant.schemaName, projectId, sourceId); // 404 if missing / not an article
    await this.sources.remove(tenant, projectId, sourceId, actorUserId);
  }
}
