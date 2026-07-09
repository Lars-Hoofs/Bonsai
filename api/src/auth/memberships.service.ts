import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import type { NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import { DB } from '../db/db.module';
import type { Db } from '../db/db.module';
import { memberships, tenants } from '../db/schema';
import type { Role } from '../db/schema';

/**
 * Any Drizzle node-postgres executor (global DB or a transaction handle),
 * generic over the schema so it structurally accepts both the schema-typed
 * global `Db` and a plain `NodePgDatabase` transaction handle.
 */
export type DbExecutor<
  TFullSchema extends Record<string, unknown> = Record<string, never>,
> = PgDatabase<NodePgQueryResultHKT, TFullSchema>;

export interface MembershipWithTenant {
  role: Role;
  tenant: { id: string; schemaName: string };
}

@Injectable()
export class MembershipsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async find(
    tenantId: string,
    userId: string,
  ): Promise<MembershipWithTenant | null> {
    const rows = await this.db
      .select({
        role: memberships.role,
        id: tenants.id,
        schemaName: tenants.schemaName,
      })
      .from(memberships)
      .innerJoin(tenants, eq(memberships.tenantId, tenants.id))
      .where(
        and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)),
      );
    const row = rows[0];
    return row
      ? { role: row.role, tenant: { id: row.id, schemaName: row.schemaName } }
      : null;
  }

  async add<TFullSchema extends Record<string, unknown>>(
    tenantId: string,
    userId: string,
    role: Role,
    tx?: DbExecutor<TFullSchema>,
  ): Promise<void> {
    const executor = tx ?? this.db;
    await executor.insert(memberships).values({ tenantId, userId, role });
  }
}
