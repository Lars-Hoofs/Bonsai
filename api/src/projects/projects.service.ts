import { Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { TenantDbService } from '../tenancy/tenant-db.service';

export interface Project {
  id: string;
  name: string;
  defaultLanguage: string;
  status: string;
  settings: Record<string, unknown>;
  retentionDays: number | null;
  createdAt: string;
  updatedAt: string;
}

function mapRow(r: Record<string, unknown>): Project {
  return {
    id: r.id as string,
    name: r.name as string,
    defaultLanguage: r.default_language as string,
    status: r.status as string,
    settings: r.settings as Record<string, unknown>,
    retentionDays: (r.retention_days as number | null) ?? null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

@Injectable()
export class ProjectsService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly audit: AuditService,
  ) {}

  create(
    schemaName: string,
    input: { name: string; defaultLanguage?: string },
  ): Promise<Project> {
    return this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(sql`
        INSERT INTO projects (name, default_language)
        VALUES (${input.name}, ${input.defaultLanguage ?? 'nl'})
        RETURNING *`);
      return mapRow(r.rows[0]);
    });
  }

  list(schemaName: string): Promise<Project[]> {
    return this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`SELECT * FROM projects ORDER BY created_at`,
      );
      return r.rows.map(mapRow);
    });
  }

  async get(schemaName: string, id: string): Promise<Project> {
    const rows = await this.tenantDb.withTenant(
      schemaName,
      async (db) =>
        (await db.execute(sql`SELECT * FROM projects WHERE id = ${id}`)).rows,
    );
    if (!rows[0]) throw new NotFoundException('Project not found');
    return mapRow(rows[0]);
  }

  async update(
    schemaName: string,
    id: string,
    input: {
      name?: string;
      defaultLanguage?: string;
      retentionDays?: number | null;
    },
  ): Promise<Project> {
    // `retentionDays` distinguishes three cases: omitted (undefined) leaves
    // the column unchanged; an explicit `null` clears the window (retain
    // forever); a positive number sets it. The COALESCE fallback flag is
    // false only when the key was actually provided.
    const retentionProvided = input.retentionDays !== undefined;
    const rows = await this.tenantDb.withTenant(
      schemaName,
      async (db) =>
        (
          await db.execute(sql`
        UPDATE projects SET
          name = COALESCE(${input.name ?? null}, name),
          default_language = COALESCE(${input.defaultLanguage ?? null}, default_language),
          retention_days = CASE WHEN ${retentionProvided}::boolean
            THEN ${input.retentionDays ?? null}::integer ELSE retention_days END,
          updated_at = now()
        WHERE id = ${id} RETURNING *`)
        ).rows,
    );
    if (!rows[0]) throw new NotFoundException('Project not found');
    return mapRow(rows[0]);
  }

  async remove(
    tenant: { id: string; schemaName: string },
    id: string,
    actorUserId: string,
  ): Promise<void> {
    // The DELETE and its audit row must commit or roll back together, so the
    // audit write happens INSIDE this withTenant transaction, using the same
    // `db` handle as the DELETE. Because the tenant search_path excludes
    // `public` (see TenantDbService.withTenant), AuditService.record targets
    // `public.audit_log` explicitly, schema-qualified, when given this `db`.
    await this.tenantDb.withTenant(tenant.schemaName, async (db) => {
      const rows = (
        await db.execute(
          sql`DELETE FROM projects WHERE id = ${id} RETURNING id`,
        )
      ).rows;
      if (!rows[0]) throw new NotFoundException('Project not found');
      await this.audit.record(
        {
          tenantId: tenant.id,
          actorUserId,
          action: 'project.deleted',
          resource: `project:${id}`,
        },
        db,
      );
    });
  }
}
