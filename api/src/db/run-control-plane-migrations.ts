import { Pool } from 'pg';
import { CONTROLPLANE_DIR, runMigrations } from './migrator';

/**
 * Applies all pending control-plane (public schema) migrations.
 *
 * Shared by production bootstrap (main.ts), the standalone migration CLI
 * (db/migrate.ts), and the integration test suite (test/helpers/app.ts) so
 * there is exactly one code path that decides how control-plane migrations
 * are run. Safe to call from multiple concurrent replicas: runMigrations
 * takes a per-track `pg_advisory_xact_lock` for the duration of each
 * migration file, so concurrent callers serialize rather than race.
 */
export async function runControlPlaneMigrations(pool: Pool): Promise<string[]> {
  return runMigrations(pool, {
    dir: CONTROLPLANE_DIR,
    schema: 'public',
    track: 'controlplane',
  });
}
