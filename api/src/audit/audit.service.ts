import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import type { NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import { DB } from '../db/db.module';
import type { Db } from '../db/db.module';
import { auditLog } from '../db/schema';

export interface AuditEntry {
  tenantId?: string;
  actorUserId?: string;
  actorApiKeyId?: string;
  action: string;
  resource: string;
  metadata?: Record<string, unknown>;
}

/**
 * Any Drizzle node-postgres executor — the global DB, or a transaction
 * handle (control-plane or tenant-scoped) obtained via `.transaction()` /
 * `TenantDbService.withTenant()`. Generic over the schema so it structurally
 * accepts both the schema-typed global `Db` and the schema-less
 * `NodePgDatabase` used inside `withTenant`.
 */
export type AuditExecutor<
  TFullSchema extends Record<string, unknown> = Record<string, never>,
> = PgDatabase<NodePgQueryResultHKT, TFullSchema>;

@Injectable()
export class AuditService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Records an audit entry.
   *
   * When `tx` is omitted, writes via the global DB (backward compatible for
   * callers with no transaction of their own).
   *
   * When `tx` is provided, the row is written using `tx` so it commits (or
   * rolls back) atomically with the caller's mutation. In that case the
   * insert targets `public.audit_log` *explicitly*, schema-qualified, via
   * raw SQL rather than the Drizzle `auditLog` table object. This is
   * required because `tx` may be a tenant-scoped transaction obtained from
   * `TenantDbService.withTenant()`, whose `search_path` is set to the
   * tenant schema (plus `shared`) and deliberately excludes `public` — an
   * unqualified `audit_log` reference in that context would resolve to a
   * nonexistent tenant-schema relation and fail.
   */
  async record<TFullSchema extends Record<string, unknown>>(
    entry: AuditEntry,
    tx?: AuditExecutor<TFullSchema>,
  ): Promise<void> {
    const tenantId = entry.tenantId ?? null;
    const actorUserId = entry.actorUserId ?? null;
    const actorApiKeyId = entry.actorApiKeyId ?? null;
    const metadata = entry.metadata ?? {};

    if (tx) {
      await tx.execute(sql`
        INSERT INTO public.audit_log
          (tenant_id, actor_user_id, actor_api_key_id, action, resource, metadata)
        VALUES
          (${tenantId}, ${actorUserId}, ${actorApiKeyId}, ${entry.action}, ${entry.resource}, ${JSON.stringify(metadata)}::jsonb)
      `);
      return;
    }

    await this.db.insert(auditLog).values({
      tenantId: entry.tenantId,
      actorUserId: entry.actorUserId,
      actorApiKeyId: entry.actorApiKeyId,
      action: entry.action,
      resource: entry.resource,
      metadata,
    });
  }
}
