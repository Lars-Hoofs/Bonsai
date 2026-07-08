import { randomBytes } from 'node:crypto';
import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { Db, DB, PG_POOL } from '../db/db.module';
import { runMigrations, TENANT_DIR } from '../db/migrator';
import { tenants } from '../db/schema';

export interface CreatedTenant {
  id: string;
  slug: string;
  schemaName: string;
}

@Injectable()
export class TenantProvisioningService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(DB) private readonly db: Db,
  ) {}

  async createTenant(input: {
    name: string;
    slug: string;
  }): Promise<CreatedTenant> {
    const existing = await this.db
      .select()
      .from(tenants)
      .where(eq(tenants.slug, input.slug));
    if (existing.length > 0)
      throw new ConflictException(`Tenant slug '${input.slug}' already exists`);

    const schemaName = `t_${randomBytes(16).toString('hex')}`;
    const [row] = await this.db
      .insert(tenants)
      .values({ name: input.name, slug: input.slug, schemaName })
      .returning();
    await this.pool.query(`CREATE SCHEMA "${schemaName}"`);
    await runMigrations(this.pool, {
      dir: TENANT_DIR,
      schema: schemaName,
      track: `tenant:${schemaName}`,
    });
    return { id: row.id, slug: row.slug, schemaName: row.schemaName };
  }
}
