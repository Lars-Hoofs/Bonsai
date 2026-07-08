import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Pool } from 'pg';

export async function startPg(): Promise<{
  container: StartedPostgreSqlContainer;
  pool: Pool;
}> {
  const container = await new PostgreSqlContainer(
    'pgvector/pgvector:pg16',
  ).start();
  const pool = new Pool({ connectionString: container.getConnectionUri() });
  return { container, pool };
}
