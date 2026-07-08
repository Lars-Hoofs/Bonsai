import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/db.module';
import { memberships, tenants } from '../db/schema';
import type { Role } from '../db/schema';

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

  async add(tenantId: string, userId: string, role: Role): Promise<void> {
    await this.db.insert(memberships).values({ tenantId, userId, role });
  }
}
