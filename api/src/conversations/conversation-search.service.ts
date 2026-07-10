import { Injectable, NotFoundException } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { TenantDbService } from '../tenancy/tenant-db.service';

export interface ConversationTag {
  id: string;
  projectId: string;
  name: string;
  color: string | null;
  createdAt: string;
}

export interface SavedFilter {
  id: string;
  projectId: string;
  ownerUserId: string;
  name: string;
  filter: RawConversationFilter;
  createdAt: string;
  updatedAt: string;
}

/**
 * A resolved conversation-list filter. Every field is optional; the search
 * endpoint ANDs together whichever fields are present. `assignee` is already
 * resolved to a concrete predicate by the controller (see
 * `AssigneeFilter` on ConversationsService) — the service never sees 'me'.
 */
export interface ConversationFilter {
  text?: string;
  status?: string;
  tagIds?: string[];
  assignee?: { userId: string } | 'unassigned';
  from?: string;
  to?: string;
}

/**
 * The unresolved filter shape as sent by a client / persisted in a saved
 * filter: here `assignee` is still the raw 'me' | 'unassigned' | user-id
 * string (resolved to a concrete predicate only at search time, since 'me'
 * depends on who's asking). This is what gets stored verbatim in
 * `conversation_saved_filters.filter`.
 */
export interface RawConversationFilter {
  text?: string;
  status?: string;
  tagIds?: string[];
  assignee?: string;
  from?: string;
  to?: string;
}

export interface ConversationSearchResult {
  id: string;
  projectId: string;
  status: string;
  language: string;
  startedAt: string;
  updatedAt: string;
  assignedAgentId: string | null;
  tags: ConversationTag[];
}

function mapTag(r: Record<string, unknown>): ConversationTag {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    name: r.name as string,
    color: (r.color as string | null) ?? null,
    createdAt: String(r.created_at),
  };
}

function mapSavedFilter(r: Record<string, unknown>): SavedFilter {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    ownerUserId: r.owner_user_id as string,
    name: r.name as string,
    filter: (r.filter as RawConversationFilter) ?? {},
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

@Injectable()
export class ConversationSearchService {
  constructor(private readonly tenantDb: TenantDbService) {}

  // --- Tags -----------------------------------------------------------------

  async createTag(
    schemaName: string,
    projectId: string,
    input: { name: string; color?: string },
  ): Promise<ConversationTag> {
    const row = await this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`INSERT INTO conversation_tags (project_id, name, color)
            VALUES (${projectId}, ${input.name}, ${input.color ?? null})
            RETURNING *`,
      );
      return r.rows[0];
    });
    return mapTag(row);
  }

  async listTags(
    schemaName: string,
    projectId: string,
  ): Promise<ConversationTag[]> {
    return this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`SELECT * FROM conversation_tags WHERE project_id = ${projectId}
            ORDER BY lower(name)`,
      );
      return r.rows.map(mapTag);
    });
  }

  async deleteTag(
    schemaName: string,
    projectId: string,
    tagId: string,
  ): Promise<void> {
    await this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`DELETE FROM conversation_tags
            WHERE id = ${tagId} AND project_id = ${projectId} RETURNING id`,
      );
      if (!r.rows[0]) throw new NotFoundException('Tag not found');
    });
  }

  /**
   * Attaches a tag to a conversation. Both the conversation and the tag must
   * belong to `projectId` (a tag from another project can never be applied).
   * Idempotent: re-tagging is a no-op via ON CONFLICT.
   */
  async tagConversation(
    schemaName: string,
    projectId: string,
    conversationId: string,
    tagId: string,
  ): Promise<void> {
    await this.tenantDb.withTenant(schemaName, async (db) => {
      const convo = await db.execute(
        sql`SELECT 1 FROM conversations
            WHERE id = ${conversationId} AND project_id = ${projectId}`,
      );
      if (!convo.rows[0]) throw new NotFoundException('Conversation not found');
      const tag = await db.execute(
        sql`SELECT 1 FROM conversation_tags
            WHERE id = ${tagId} AND project_id = ${projectId}`,
      );
      if (!tag.rows[0]) throw new NotFoundException('Tag not found');
      await db.execute(
        sql`INSERT INTO conversation_tag_assignments (conversation_id, tag_id)
            VALUES (${conversationId}, ${tagId})
            ON CONFLICT (conversation_id, tag_id) DO NOTHING`,
      );
    });
  }

  async untagConversation(
    schemaName: string,
    projectId: string,
    conversationId: string,
    tagId: string,
  ): Promise<void> {
    await this.tenantDb.withTenant(schemaName, async (db) => {
      const convo = await db.execute(
        sql`SELECT 1 FROM conversations
            WHERE id = ${conversationId} AND project_id = ${projectId}`,
      );
      if (!convo.rows[0]) throw new NotFoundException('Conversation not found');
      await db.execute(
        sql`DELETE FROM conversation_tag_assignments
            WHERE conversation_id = ${conversationId} AND tag_id = ${tagId}`,
      );
    });
  }

  // --- Saved filters --------------------------------------------------------

  async createSavedFilter(
    schemaName: string,
    projectId: string,
    ownerUserId: string,
    input: { name: string; filter: RawConversationFilter },
  ): Promise<SavedFilter> {
    const row = await this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`INSERT INTO conversation_saved_filters
              (project_id, owner_user_id, name, filter)
            VALUES (${projectId}, ${ownerUserId}, ${input.name},
                    ${sql.param(input.filter)}::jsonb)
            RETURNING *`,
      );
      return r.rows[0];
    });
    return mapSavedFilter(row);
  }

  /**
   * Lists the calling agent's own saved filters for the project. Filters are
   * private to their owner (each agent curates their own presets).
   */
  async listSavedFilters(
    schemaName: string,
    projectId: string,
    ownerUserId: string,
  ): Promise<SavedFilter[]> {
    return this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`SELECT * FROM conversation_saved_filters
            WHERE project_id = ${projectId} AND owner_user_id = ${ownerUserId}
            ORDER BY lower(name)`,
      );
      return r.rows.map(mapSavedFilter);
    });
  }

  async deleteSavedFilter(
    schemaName: string,
    projectId: string,
    ownerUserId: string,
    filterId: string,
  ): Promise<void> {
    await this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`DELETE FROM conversation_saved_filters
            WHERE id = ${filterId} AND project_id = ${projectId}
              AND owner_user_id = ${ownerUserId}
            RETURNING id`,
      );
      if (!r.rows[0]) throw new NotFoundException('Saved filter not found');
    });
  }

  // --- Search ---------------------------------------------------------------

  /**
   * Filtered/searched conversation list. Every present filter field is ANDed:
   *  - `text`   full-text match over the conversation's message content
   *             (websearch_to_tsquery over the maintained `search_tsv`)
   *  - `status` exact conversation status
   *  - `tagIds` conversation must carry ALL the given tags
   *  - `assignee` a specific agent, or 'unassigned'
   *  - `from`/`to` bound the conversation's `updated_at`
   * Ordered by relevance when a text query is present, otherwise most-recently
   * updated first. Bounded to `limit` rows (default 50, max 200).
   */
  async search(
    schemaName: string,
    projectId: string,
    filter: ConversationFilter,
    limit = 50,
  ): Promise<ConversationSearchResult[]> {
    const clauses: SQL[] = [sql`c.project_id = ${projectId}`];

    const text = filter.text?.trim();
    if (text) {
      clauses.push(
        sql`c.search_tsv @@ websearch_to_tsquery('simple', ${text})`,
      );
    }
    if (filter.status) {
      clauses.push(sql`c.status = ${filter.status}`);
    }
    if (filter.assignee === 'unassigned') {
      clauses.push(sql`c.assigned_agent_id IS NULL`);
    } else if (filter.assignee) {
      clauses.push(sql`c.assigned_agent_id = ${filter.assignee.userId}`);
    }
    if (filter.from) {
      clauses.push(sql`c.updated_at >= ${filter.from}`);
    }
    if (filter.to) {
      clauses.push(sql`c.updated_at <= ${filter.to}`);
    }
    const tagIds = filter.tagIds?.filter((t) => t.length > 0) ?? [];
    if (tagIds.length > 0) {
      // Require ALL requested tags: count matching assignments == #tags.
      clauses.push(sql`(
        SELECT count(*) FROM conversation_tag_assignments cta
        WHERE cta.conversation_id = c.id
          AND cta.tag_id IN (${sql.join(
            tagIds.map((t) => sql`${t}`),
            sql`, `,
          )})
      ) = ${tagIds.length}`);
    }

    const where = sql.join(clauses, sql` AND `);
    const boundedLimit = Math.min(Math.max(limit, 1), 200);
    const orderBy = text
      ? sql`ts_rank(c.search_tsv, websearch_to_tsquery('simple', ${text})) DESC, c.updated_at DESC`
      : sql`c.updated_at DESC`;

    return this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(sql`
        SELECT c.id, c.project_id, c.status, c.language,
               c.started_at, c.updated_at, c.assigned_agent_id,
               COALESCE(
                 (SELECT json_agg(t ORDER BY lower(t.name))
                    FROM conversation_tags t
                    JOIN conversation_tag_assignments cta ON cta.tag_id = t.id
                   WHERE cta.conversation_id = c.id),
                 '[]'::json
               ) AS tags
        FROM conversations c
        WHERE ${where}
        ORDER BY ${orderBy}
        LIMIT ${boundedLimit}`);
      return r.rows.map((row) => this.mapResult(row));
    });
  }

  private mapResult(row: Record<string, unknown>): ConversationSearchResult {
    const rawTags = (row.tags as Record<string, unknown>[] | null) ?? [];
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      status: row.status as string,
      language: row.language as string,
      startedAt: String(row.started_at),
      updatedAt: String(row.updated_at),
      assignedAgentId: (row.assigned_agent_id as string | null) ?? null,
      tags: rawTags.map(mapTag),
    };
  }
}
