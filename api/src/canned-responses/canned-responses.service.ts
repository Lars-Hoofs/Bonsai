import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { TenantDbService } from '../tenancy/tenant-db.service';

export interface CannedResponse {
  id: string;
  projectId: string;
  title: string;
  body: string;
  variables: string[];
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CannedResponseInput {
  title: string;
  body: string;
  variables?: string[];
}

function mapRow(r: Record<string, unknown>): CannedResponse {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    title: r.title as string,
    body: r.body as string,
    variables: (r.variables as string[]) ?? [],
    createdBy: (r.created_by as string | null) ?? null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

// Postgres unique_violation.
const UNIQUE_VIOLATION = '23505';

function isDuplicateTitle(e: unknown): boolean {
  // Drizzle wraps the underlying pg DatabaseError in a generic Error whose
  // `cause` holds the real driver error, so unwrap one level. Duck-type
  // rather than `instanceof` (class identity isn't reliable across the
  // drizzle/pg module boundary): a unique-violation on the per-project
  // lower(title) index means the title is already taken.
  if (typeof e !== 'object' || e === null) return false;
  const err = e as { code?: unknown; constraint?: unknown; cause?: unknown };
  const pg =
    err.code === undefined && err.cause
      ? (err.cause as { code?: unknown; constraint?: unknown })
      : err;
  return (
    pg.code === UNIQUE_VIOLATION &&
    typeof pg.constraint === 'string' &&
    pg.constraint.includes('lower_title')
  );
}

/**
 * Renders a canned-response body by substituting every `{{name}}` token whose
 * `name` has a value in `values`. Names not present in `values` are left as
 * the literal `{{name}}` token so the agent can see what still needs filling
 * in. Matching is whitespace-tolerant inside the braces (`{{ name }}`).
 */
export function renderBody(
  body: string,
  values: Record<string, unknown>,
): string {
  return body.replace(
    /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g,
    (match, name: string) => {
      if (Object.prototype.hasOwnProperty.call(values, name)) {
        return stringifyValue(values[name]);
      }
      return match;
    },
  );
}

/**
 * Coerces a substitution value to a string for insertion into a rendered
 * body. `null`/`undefined` become empty strings; objects/arrays are
 * JSON-encoded (rather than yielding `[object Object]`); everything else uses
 * the primitive's string form.
 */
function stringifyValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint')
    return String(v);
  return '';
}

@Injectable()
export class CannedResponsesService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly audit: AuditService,
  ) {}

  async create(
    schemaName: string,
    projectId: string,
    input: CannedResponseInput,
    actorUserId: string,
    tenantId: string,
  ): Promise<CannedResponse> {
    const variables = input.variables ?? [];
    let row: Record<string, unknown>;
    try {
      row = await this.tenantDb.withTenant(schemaName, async (db) => {
        const r = await db.execute(sql`
          INSERT INTO canned_responses (project_id, title, body, variables, created_by)
          VALUES (
            ${projectId},
            ${input.title},
            ${input.body},
            ${sql.param(variables)}::text[],
            ${actorUserId}
          )
          RETURNING *`);
        return r.rows[0];
      });
    } catch (e) {
      if (isDuplicateTitle(e))
        throw new ConflictException(
          'A canned response with this title already exists',
        );
      throw e;
    }
    const response = mapRow(row);
    await this.audit.record({
      tenantId,
      actorUserId,
      action: 'canned_response.created',
      resource: `canned_response:${response.id}`,
    });
    return response;
  }

  async list(schemaName: string, projectId: string): Promise<CannedResponse[]> {
    return this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`SELECT * FROM canned_responses WHERE project_id = ${projectId} ORDER BY lower(title)`,
      );
      return r.rows.map(mapRow);
    });
  }

  async get(
    schemaName: string,
    projectId: string,
    id: string,
  ): Promise<CannedResponse> {
    const rows = await this.tenantDb.withTenant(
      schemaName,
      async (db) =>
        (
          await db.execute(
            sql`SELECT * FROM canned_responses WHERE id = ${id} AND project_id = ${projectId}`,
          )
        ).rows,
    );
    if (!rows[0]) throw new NotFoundException('Canned response not found');
    return mapRow(rows[0]);
  }

  async update(
    schemaName: string,
    projectId: string,
    id: string,
    input: Partial<CannedResponseInput>,
    actorUserId: string,
    tenantId: string,
  ): Promise<CannedResponse> {
    const variables = input.variables ?? null;
    let rows: Record<string, unknown>[];
    try {
      rows = await this.tenantDb.withTenant(schemaName, async (db) => {
        const r = await db.execute(sql`
          UPDATE canned_responses SET
            title = COALESCE(${input.title ?? null}, title),
            body = COALESCE(${input.body ?? null}, body),
            variables = COALESCE(${variables === null ? null : sql.param(variables)}::text[], variables),
            updated_at = now()
          WHERE id = ${id} AND project_id = ${projectId}
          RETURNING *`);
        return r.rows;
      });
    } catch (e) {
      if (isDuplicateTitle(e))
        throw new ConflictException(
          'A canned response with this title already exists',
        );
      throw e;
    }
    if (!rows[0]) throw new NotFoundException('Canned response not found');
    const response = mapRow(rows[0]);
    await this.audit.record({
      tenantId,
      actorUserId,
      action: 'canned_response.updated',
      resource: `canned_response:${id}`,
    });
    return response;
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
          sql`DELETE FROM canned_responses WHERE id = ${id} AND project_id = ${projectId} RETURNING id`,
        )
      ).rows;
      if (!rows[0]) throw new NotFoundException('Canned response not found');
      await this.audit.record(
        {
          tenantId: tenant.id,
          actorUserId,
          action: 'canned_response.deleted',
          resource: `canned_response:${id}`,
        },
        db,
      );
    });
  }

  /**
   * Loads a canned response and returns its body with `{{placeholder}}` tokens
   * substituted from `values`. Used by the agent console to preview / produce
   * the text to insert into a reply before sending it via the normal
   * agent-message flow. Purely read + string substitution — no message is
   * created here.
   */
  async render(
    schemaName: string,
    projectId: string,
    id: string,
    values: Record<string, unknown>,
  ): Promise<{ id: string; title: string; body: string; rendered: string }> {
    const response = await this.get(schemaName, projectId, id);
    return {
      id: response.id,
      title: response.title,
      body: response.body,
      rendered: renderBody(response.body, values),
    };
  }
}
