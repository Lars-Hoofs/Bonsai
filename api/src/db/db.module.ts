import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { APP_CONFIG, AppConfig, loadConfig } from '../config/config';
import * as schema from './schema';

export const PG_POOL = Symbol('PG_POOL');
export const DB = Symbol('DB');
export type Db = NodePgDatabase<typeof schema>;

@Global()
@Module({
  providers: [
    { provide: APP_CONFIG, useFactory: () => loadConfig(process.env) },
    {
      provide: PG_POOL,
      useFactory: (cfg: AppConfig) =>
        new Pool({
          connectionString: cfg.databaseUrl,
          // Availability guardrails: cap runaway queries and abandoned open
          // transactions so one tenant's slow/stuck query can't starve the
          // shared pool. Configurable via DB_STATEMENT_TIMEOUT_MS /
          // DB_IDLE_TX_TIMEOUT_MS (see config.ts) so ops can raise them for a
          // deployment without a code change. Note: the control-plane
          // migration runner (migrator.ts) exempts its own session from
          // statement_timeout, since DDL can legitimately run long and must
          // not be killed mid-migration.
          statement_timeout: cfg.dbStatementTimeoutMs,
          idle_in_transaction_session_timeout: cfg.dbIdleTxTimeoutMs,
          // Bounds how long a caller waits to acquire a connection from the
          // pool (e.g. under pool exhaustion) rather than hanging forever.
          connectionTimeoutMillis: 10_000,
        }),
      inject: [APP_CONFIG],
    },
    {
      provide: DB,
      useFactory: (pool: Pool) => drizzle(pool, { schema }),
      inject: [PG_POOL],
    },
  ],
  exports: [APP_CONFIG, PG_POOL, DB],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
