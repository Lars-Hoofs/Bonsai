import { Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { TenantDbService } from '../tenancy/tenant-db.service';

export interface Synonym {
  id: string;
  projectId: string;
  term: string;
  aliases: string[];
  createdAt: string;
}

export interface SynonymInput {
  term: string;
  aliases: string[];
}

function mapRow(r: Record<string, unknown>): Synonym {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    term: r.term as string,
    aliases: (r.aliases as string[]) ?? [],
    createdAt: String(r.created_at),
  };
}

/**
 * Escapes a string for safe use inside a JS RegExp (used to word-match a
 * synonym term against the raw query text).
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

@Injectable()
export class SynonymsService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly audit: AuditService,
  ) {}

  async create(
    schemaName: string,
    projectId: string,
    input: SynonymInput,
    actorUserId: string,
    tenantId: string,
  ): Promise<Synonym> {
    const row = await this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(sql`
        INSERT INTO synonyms (project_id, term, aliases)
        VALUES (${projectId}, ${input.term}, ${sql.param(input.aliases)}::text[])
        RETURNING *`);
      return r.rows[0];
    });
    const synonym = mapRow(row);
    await this.audit.record({
      tenantId,
      actorUserId,
      action: 'synonym.created',
      resource: `synonym:${synonym.id}`,
    });
    return synonym;
  }

  async list(schemaName: string, projectId: string): Promise<Synonym[]> {
    return this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`SELECT * FROM synonyms WHERE project_id = ${projectId} ORDER BY created_at`,
      );
      return r.rows.map(mapRow);
    });
  }

  async remove(
    tenant: { id: string; schemaName: string },
    projectId: string,
    id: string,
    actorUserId: string,
  ): Promise<void> {
    await this.tenantDb.withTenant(tenant.schemaName, async (db) => {
      const rows = (
        await db.execute(
          sql`DELETE FROM synonyms WHERE id = ${id} AND project_id = ${projectId} RETURNING id`,
        )
      ).rows;
      if (!rows[0]) throw new NotFoundException('Synonym not found');
      await this.audit.record(
        {
          tenantId: tenant.id,
          actorUserId,
          action: 'synonym.deleted',
          resource: `synonym:${id}`,
        },
        db,
      );
    });
  }

  /**
   * Expands a lexical (FTS) query string with alias terms: for every synonym
   * registered for the project whose `term` appears as a whole word
   * (case-insensitive) in `query`, appends that synonym's aliases to the end
   * of the query text. This widens `plainto_tsquery`'s OR-free AND-of-terms
   * matching so a query using the TERM ("retour") also matches chunks that
   * only contain an ALIAS ("terugsturen"). Deliberately simple/additive:
   * when a project has no synonyms configured, or none of its terms appear
   * in the query, the returned string equals the input `query` exactly —
   * so retrieval behavior for projects without synonyms is unchanged.
   */
  async expandQuery(
    schemaName: string,
    projectId: string,
    query: string,
  ): Promise<string> {
    const synonyms = await this.list(schemaName, projectId);
    if (synonyms.length === 0) return query;

    const extra: string[] = [];
    for (const syn of synonyms) {
      const re = new RegExp(`\\b${escapeRegExp(syn.term)}\\b`, 'iu');
      if (re.test(query)) {
        extra.push(...syn.aliases);
      }
    }
    if (extra.length === 0) return query;
    return `${query} ${extra.join(' ')}`;
  }
}
