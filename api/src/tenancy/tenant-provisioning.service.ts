import { randomBytes } from 'node:crypto';
import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import type { Db } from '../db/db.module';
import { DB, PG_POOL } from '../db/db.module';
import { runMigrations, TENANT_DIR } from '../db/migrator';
import { tenants } from '../db/schema';

export interface CreatedTenant {
  id: string;
  slug: string;
  schemaName: string;
}

/**
 * The migration runner, injectable so tests can force a failure after the
 * schema has been created (exercising the compensation/cleanup path).
 * Defaults to the real {@link runMigrations}.
 */
export type MigrateFn = (
  pool: Pool,
  opts: { dir: string; schema: string; track: string },
) => Promise<string[]>;

interface PgError {
  code: string;
}

function isPgError(e: unknown): e is PgError {
  return (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    typeof (e as { code?: unknown }).code === 'string'
  );
}

/**
 * Detects a Postgres unique-violation (23505), unwrapping one level of
 * `.cause` since drivers/ORMs (e.g. Drizzle's DrizzleQueryError) commonly
 * wrap the underlying pg error rather than exposing `code` directly.
 */
function isUniqueViolation(err: unknown): boolean {
  if (isPgError(err) && err.code === '23505') return true;
  if (
    typeof err === 'object' &&
    err !== null &&
    'cause' in err &&
    isPgError((err as { cause?: unknown }).cause)
  ) {
    return (err as { cause: PgError }).cause.code === '23505';
  }
  return false;
}

@Injectable()
export class TenantProvisioningService {
  private readonly logger = new Logger(TenantProvisioningService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(DB) private readonly db: Db,
    @Optional() private readonly migrateFn: MigrateFn = runMigrations,
  ) {}

  async createTenant(input: {
    name: string;
    slug: string;
  }): Promise<CreatedTenant> {
    // Fast path only: the real guarantee against a concurrent duplicate is the
    // DB unique constraint on slug, handled in the catch below.
    const existing = await this.db
      .select()
      .from(tenants)
      .where(eq(tenants.slug, input.slug));
    if (existing.length > 0)
      throw new ConflictException(`Tenant slug '${input.slug}' already exists`);

    // Provision the schema BEFORE inserting the tenant row, so the row (and
    // its slug) is only committed once the schema is fully migrated. On any
    // failure the schema is dropped so no orphan remains and the slug is free.
    const schemaName = `t_${randomBytes(16).toString('hex')}`;
    await this.pool.query(`CREATE SCHEMA "${schemaName}"`);
    let row: { id: string; slug: string; schemaName: string };
    try {
      await this.migrateFn(this.pool, {
        dir: TENANT_DIR,
        schema: schemaName,
        track: `tenant:${schemaName}`,
      });
      [row] = await this.db
        .insert(tenants)
        .values({ name: input.name, slug: input.slug, schemaName })
        .returning();
    } catch (err) {
      await this.dropSchemaQuietly(schemaName);
      if (isUniqueViolation(err))
        throw new ConflictException(`Tenant slug '${input.slug}' already exists`);
      throw err;
    }
    return { id: row.id, slug: row.slug, schemaName: row.schemaName };
  }

  /**
   * Best-effort cleanup: a failed drop must not mask the original provisioning
   * error, so it is logged and swallowed rather than thrown.
   */
  private async dropSchemaQuietly(schemaName: string): Promise<void> {
    try {
      await this.pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    } catch (dropErr) {
      this.logger.error(
        `Failed to drop schema "${schemaName}" during provisioning cleanup`,
        dropErr instanceof Error ? dropErr.stack : String(dropErr),
      );
    }
  }
}
