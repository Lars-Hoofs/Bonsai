import { Inject, Injectable } from '@nestjs/common';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { PG_POOL } from '../db/db.module';

const TENANT_SCHEMA_RE = /^t_[0-9a-f]{32}$/;

@Injectable()
export class TenantDbService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async withTenant<T>(
    schemaName: string,
    fn: (db: NodePgDatabase) => Promise<T>,
  ): Promise<T> {
    if (!TENANT_SCHEMA_RE.test(schemaName))
      throw new Error('Invalid tenant schema');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Isolation by construction: the runtime tenant search_path is the
      // tenant schema plus `shared` (extensions only, e.g. pgvector) — but
      // NOT `public`, which holds control-plane tables (tenants, users,
      // memberships, api_keys, audit_log). Tenant-scoped code therefore
      // cannot reach another tenant's or the platform's data via an
      // unqualified table reference, while vector types/operators (in
      // `shared`) and built-ins (pg_catalog) still resolve.
      await client.query(`SET LOCAL search_path TO "${schemaName}", shared`);
      const result = await fn(drizzle(client));
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
}
