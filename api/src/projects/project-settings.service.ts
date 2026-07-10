import { Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { TenantDbService } from '../tenancy/tenant-db.service';
import { assertSettingsPatchShape } from './settings-validation';

/**
 * Managed read/write of the `projects.settings` jsonb blob (Feature #33).
 *
 * This service does NOT change how other services (AnswerService,
 * ConversationsService, ...) read individual settings values — they keep
 * doing their own tolerant, best-effort parsing of whatever is in the
 * jsonb. This is purely the write-side gate (validate + merge) and a
 * read-side passthrough of the whole object, so tests/operators no longer
 * need to write `projects.settings` via raw SQL.
 */
@Injectable()
export class ProjectSettingsService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly audit: AuditService,
  ) {}

  async get(
    schemaName: string,
    projectId: string,
  ): Promise<Record<string, unknown>> {
    const rows = await this.tenantDb.withTenant(
      schemaName,
      async (db) =>
        (
          await db.execute(
            sql`SELECT settings FROM projects WHERE id = ${projectId}`,
          )
        ).rows,
    );
    const row = rows[0] as { settings?: Record<string, unknown> } | undefined;
    if (!row) throw new NotFoundException('Project not found');
    return row.settings ?? {};
  }

  async update(
    tenant: { id: string; schemaName: string },
    projectId: string,
    actorUserId: string,
    patch: unknown,
  ): Promise<Record<string, unknown>> {
    assertSettingsPatchShape(patch);

    return this.tenantDb.withTenant(tenant.schemaName, async (db) => {
      const existingRows = (
        await db.execute(
          sql`SELECT settings FROM projects WHERE id = ${projectId}`,
        )
      ).rows as { settings?: Record<string, unknown> }[];
      if (!existingRows[0]) throw new NotFoundException('Project not found');

      const merged = {
        ...(existingRows[0].settings ?? {}),
        ...patch,
      };

      const updatedRows = (
        await db.execute(sql`
          UPDATE projects SET
            settings = ${JSON.stringify(merged)}::jsonb,
            updated_at = now()
          WHERE id = ${projectId} RETURNING settings`)
      ).rows as { settings: Record<string, unknown> }[];

      // The audit write must commit/roll back atomically with the
      // settings UPDATE, so it's recorded on this same `db` handle inside
      // this withTenant transaction (see AuditService.record's doc on why
      // this targets public.audit_log explicitly when given a tenant-scoped
      // executor whose search_path excludes `public`).
      await this.audit.record(
        {
          tenantId: tenant.id,
          actorUserId,
          action: 'project.settings_updated',
          resource: `project:${projectId}`,
          metadata: { patch },
        },
        db,
      );

      return updatedRows[0].settings;
    });
  }
}
