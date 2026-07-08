import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

export const CONTROLPLANE_DIR = join(
  __dirname,
  '..',
  '..',
  'drizzle',
  'controlplane',
);
export const TENANT_DIR = join(__dirname, '..', '..', 'drizzle', 'tenant');

const SCHEMA_RE = /^(public|t_[0-9a-f]{32})$/;

export async function runMigrations(
  pool: Pool,
  opts: { dir: string; schema: string; track: string },
): Promise<string[]> {
  if (!SCHEMA_RE.test(opts.schema))
    throw new Error(`Invalid schema name: ${opts.schema}`);
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS public.migrations (
      track text NOT NULL, version text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (track, version))`);
    const files = readdirSync(opts.dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      await client.query('BEGIN');
      try {
        const seen = await client.query(
          'SELECT 1 FROM public.migrations WHERE track = $1 AND version = $2',
          [opts.track, file],
        );
        if (seen.rowCount) {
          await client.query('ROLLBACK');
          continue;
        }
        await client.query(`SET LOCAL search_path TO "${opts.schema}", public`);
        await client.query(readFileSync(join(opts.dir, file), 'utf8'));
        await client.query(
          'INSERT INTO public.migrations (track, version) VALUES ($1, $2)',
          [opts.track, file],
        );
        await client.query('COMMIT');
        applied.push(file);
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }
    return applied;
  } finally {
    client.release();
  }
}
