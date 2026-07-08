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

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === '23505'
  );
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
    await this.pool.query(`CREATE SCHEMA "${schemaName}"`);
    try {
      await runMigrations(this.pool, {
        dir: TENANT_DIR,
        schema: schemaName,
        track: `tenant:${schemaName}`,
      });
      const [row] = await this.db
        .insert(tenants)
        .values({ name: input.name, slug: input.slug, schemaName })
        .returning();
      return { id: row.id, slug: row.slug, schemaName: row.schemaName };
    } catch (err) {
      await this.pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      if (isUniqueViolation(err))
        throw new ConflictException(
          `Tenant slug '${input.slug}' already exists`,
        );
      throw err;
    }
  }
}
