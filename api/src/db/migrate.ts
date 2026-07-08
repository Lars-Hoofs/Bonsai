import 'dotenv/config';
import { Pool } from 'pg';
import { runControlPlaneMigrations } from './run-control-plane-migrations';

/**
 * Standalone CLI entry point for applying control-plane migrations,
 * e.g. as a release/predeploy step: `pnpm migrate` (runs `node dist/db/migrate.js`
 * after `pnpm build`). Reads DATABASE_URL directly from the environment so it
 * can run outside of the Nest application context.
 */
async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const applied = await runControlPlaneMigrations(pool);
    if (applied.length === 0) {
      console.log('Control-plane migrations: nothing to apply.');
    } else {
      console.log('Control-plane migrations applied:');
      for (const version of applied) console.log(`  - ${version}`);
    }
  } finally {
    await pool.end();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error('Migration failed:', error);
    process.exit(1);
  });
