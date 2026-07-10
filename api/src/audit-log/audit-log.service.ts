import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, lte, SQL } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/db.module';
import { auditLog } from '../db/schema';
import { AuditLogFilterDto } from './dto';

export interface AuditLogRow {
  id: number;
  action: string;
  resource: string;
  actorUserId: string | null;
  actorApiKeyId: string | null;
  metadata: unknown;
  createdAt: Date;
}

// Hard ceiling on export size regardless of caller intent, so a single
// export request can't pull an unbounded number of rows into memory.
export const AUDIT_LOG_EXPORT_MAX_ROWS = 10_000;

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

@Injectable()
export class AuditLogService {
  constructor(@Inject(DB) private readonly db: Db) {}

  private buildWhere(tenantId: string, filter: AuditLogFilterDto): SQL {
    const conditions: SQL[] = [eq(auditLog.tenantId, tenantId)];
    if (filter.action) conditions.push(eq(auditLog.action, filter.action));
    if (filter.actorUserId) {
      conditions.push(eq(auditLog.actorUserId, filter.actorUserId));
    }
    if (filter.from)
      conditions.push(gte(auditLog.createdAt, new Date(filter.from)));
    if (filter.to)
      conditions.push(lte(auditLog.createdAt, new Date(filter.to)));
    // `conditions` always has at least the tenant scope, so `and(...)` never
    // returns undefined here.
    return and(...conditions) as SQL;
  }

  async list(
    tenantId: string,
    filter: AuditLogFilterDto,
    pagination: { limit?: number; offset?: number },
  ): Promise<AuditLogRow[]> {
    const limit = Math.min(
      pagination.limit ?? DEFAULT_LIST_LIMIT,
      MAX_LIST_LIMIT,
    );
    const offset = pagination.offset ?? 0;
    return this.db
      .select({
        id: auditLog.id,
        action: auditLog.action,
        resource: auditLog.resource,
        actorUserId: auditLog.actorUserId,
        actorApiKeyId: auditLog.actorApiKeyId,
        metadata: auditLog.metadata,
        createdAt: auditLog.createdAt,
      })
      .from(auditLog)
      .where(this.buildWhere(tenantId, filter))
      .orderBy(desc(auditLog.createdAt))
      .limit(limit)
      .offset(offset);
  }

  async forExport(
    tenantId: string,
    filter: AuditLogFilterDto,
  ): Promise<AuditLogRow[]> {
    return this.db
      .select({
        id: auditLog.id,
        action: auditLog.action,
        resource: auditLog.resource,
        actorUserId: auditLog.actorUserId,
        actorApiKeyId: auditLog.actorApiKeyId,
        metadata: auditLog.metadata,
        createdAt: auditLog.createdAt,
      })
      .from(auditLog)
      .where(this.buildWhere(tenantId, filter))
      .orderBy(desc(auditLog.createdAt))
      .limit(AUDIT_LOG_EXPORT_MAX_ROWS);
  }
}
