# Phase 1: Platform Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A running NestJS API with schema-per-tenant Postgres isolation, OIDC auth, RBAC, API keys, append-only audit logging, and Docker Compose deployment — the compliance-grade bedrock every later phase builds on.

**Architecture:** Modular NestJS monolith in `api/`. Control-plane tables live in the Postgres `public` schema; each tenant gets its own `t_<hex>` schema provisioned at tenant creation via a per-tenant migration track. All tenant-scoped queries run inside a transaction with `SET LOCAL search_path`. Auth = managed OIDC provider (JWT validation only, swappable); RBAC via membership roles.

**Tech Stack:** Node ≥22, pnpm, NestJS 11 (Express), TypeScript strict, Drizzle ORM + `pg`, `jose` (JWT), Jest + Supertest + `@testcontainers/postgresql`, Docker Compose (pgvector/pg16, redis, caddy).

## Global Constraints

- TypeScript `strict: true`; no `any` in committed code.
- TDD: every task writes the failing test first. Integration tests use a real Postgres via testcontainers (Docker must be running).
- Conventional commits; commit at the end of every task. Commit trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Tenant schema names MUST match `/^t_[0-9a-f]{32}$/` and MUST be validated before any SQL interpolation.
- Never log message content or PII; log IDs only.
- All timestamps `timestamptz`, UTC.
- Roles and rank (used by RBAC hierarchy checks): `owner:5, admin:4, editor:3, agent:2, viewer:1`.
- API key format: `bsk_<43 chars base64url>`; only SHA-256 hash + 12-char prefix stored.
- Env vars (validated by zod, see Task 1): `DATABASE_URL`, `PORT` (default 3000), `NODE_ENV`, `OIDC_ISSUER`, `OIDC_AUDIENCE`, `OIDC_JWKS_URL`.
- All work happens under `api/` unless a path starts with `/` or another top-level dir (e.g. `docker-compose.yml`).

---

### Task 1: Project scaffold, strict TS, zod-validated config, health endpoint

**Files:**
- Create: `api/` (Nest scaffold), `api/src/config/config.ts`, `api/src/config/config.spec.ts`, `api/src/health/health.controller.ts`, `api/src/health/health.controller.spec.ts`
- Modify: `api/tsconfig.json`, `api/src/app.module.ts`, `api/package.json`
- Delete: scaffolded `api/src/app.controller.ts`, `api/src/app.service.ts`, `api/src/app.controller.spec.ts`

**Interfaces:**
- Produces: `loadConfig(env: NodeJS.ProcessEnv): AppConfig` where `AppConfig = { databaseUrl: string; port: number; nodeEnv: 'development'|'test'|'production'; oidcIssuer: string; oidcAudience: string; oidcJwksUrl: string }`; DI token `APP_CONFIG` provided in `AppModule`. `GET /health` → `{ status: 'ok' }`.

- [ ] **Step 1: Scaffold**

```bash
cd /Users/lars/bonsai
pnpm dlx @nestjs/cli@latest new api --package-manager pnpm --skip-git
cd api && rm src/app.controller.ts src/app.service.ts src/app.controller.spec.ts
pnpm add zod pg drizzle-orm jose
pnpm add -D @types/pg @testcontainers/postgresql supertest @types/supertest
```

In `api/tsconfig.json` set: `"strict": true, "noImplicitAny": true, "strictNullChecks": true` (keep `emitDecoratorMetadata`/`experimentalDecorators`). Add to `api/package.json` scripts: `"test:int": "jest --config ./test/jest-int.json --runInBand"`.

- [ ] **Step 2: Write failing tests**

`api/src/config/config.spec.ts`:
```ts
import { loadConfig } from './config';

const valid = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/bonsai',
  OIDC_ISSUER: 'https://id.example.eu',
  OIDC_AUDIENCE: 'bonsai-api',
  OIDC_JWKS_URL: 'https://id.example.eu/keys',
  NODE_ENV: 'test',
};

describe('loadConfig', () => {
  it('parses valid env with default port', () => {
    const cfg = loadConfig(valid);
    expect(cfg.port).toBe(3000);
    expect(cfg.oidcIssuer).toBe('https://id.example.eu');
  });
  it('throws on missing DATABASE_URL', () => {
    const { DATABASE_URL, ...rest } = valid;
    expect(() => loadConfig(rest)).toThrow(/DATABASE_URL/);
  });
});
```

`api/src/health/health.controller.spec.ts`:
```ts
import { Test } from '@nestjs/testing';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('returns ok', async () => {
    const mod = await Test.createTestingModule({ controllers: [HealthController] }).compile();
    expect(mod.get(HealthController).check()).toEqual({ status: 'ok' });
  });
});
```

- [ ] **Step 3: Run tests to verify failure** — `cd api && pnpm test` → FAIL (modules not found).

- [ ] **Step 4: Implement**

`api/src/config/config.ts`:
```ts
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  OIDC_ISSUER: z.string().url(),
  OIDC_AUDIENCE: z.string().min(1),
  OIDC_JWKS_URL: z.string().url(),
});

export interface AppConfig {
  databaseUrl: string;
  port: number;
  nodeEnv: 'development' | 'test' | 'production';
  oidcIssuer: string;
  oidcAudience: string;
  oidcJwksUrl: string;
}

export const APP_CONFIG = Symbol('APP_CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const r = schema.safeParse(env);
  if (!r.success) {
    throw new Error(`Invalid configuration: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const d = r.data;
  return {
    databaseUrl: d.DATABASE_URL,
    port: d.PORT,
    nodeEnv: d.NODE_ENV,
    oidcIssuer: d.OIDC_ISSUER,
    oidcAudience: d.OIDC_AUDIENCE,
    oidcJwksUrl: d.OIDC_JWKS_URL,
  };
}
```

`api/src/health/health.controller.ts`:
```ts
import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  check(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
```

`api/src/app.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import { APP_CONFIG, loadConfig } from './config/config';

@Module({
  controllers: [HealthController],
  providers: [{ provide: APP_CONFIG, useFactory: () => loadConfig(process.env) }],
  exports: [APP_CONFIG],
})
export class AppModule {}
```

Also create `api/test/jest-int.json`:
```json
{
  "moduleFileExtensions": ["js", "json", "ts"],
  "rootDir": "..",
  "testRegex": ".integration.spec.ts$",
  "transform": { "^.+\\.ts$": "ts-jest" },
  "testEnvironment": "node",
  "testTimeout": 120000
}
```

And `/Users/lars/bonsai/.gitignore`: `node_modules/`, `dist/`, `.env`, `coverage/`.

- [ ] **Step 5: Run tests** — `pnpm test` → 3 passing.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(api): scaffold NestJS with strict TS, zod config, health endpoint"`

---

### Task 2: Docker Compose (dev infra) + migration runner + control-plane migration

**Files:**
- Create: `/Users/lars/bonsai/docker-compose.yml`, `api/drizzle/controlplane/0001_init.sql`, `api/drizzle/tenant/0001_init.sql`, `api/src/db/migrator.ts`, `api/test/migrator.integration.spec.ts`, `api/test/helpers/pg.ts`

**Interfaces:**
- Produces: `runMigrations(pool: Pool, opts: { dir: string; schema: string; track: string }): Promise<string[]>` (returns applied versions, idempotent). Tracking table `public.migrations(track text, version text, applied_at timestamptz, PRIMARY KEY(track, version))`. Helper `startPg(): Promise<{ container: StartedPostgreSqlContainer; pool: Pool }>`. Constants `CONTROLPLANE_DIR`, `TENANT_DIR` (absolute paths to the SQL dirs).

- [ ] **Step 1: Write docker-compose.yml** (repo root)

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: bonsai
      POSTGRES_PASSWORD: bonsai_dev
      POSTGRES_DB: bonsai
    ports: ["5432:5432"]
    volumes: [pgdata:/var/lib/postgresql/data]
  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
volumes:
  pgdata:
```

- [ ] **Step 2: Write the SQL migrations**

`api/drizzle/controlplane/0001_init.sql`:
```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  schema_name text NOT NULL UNIQUE,
  plan text NOT NULL DEFAULT 'starter',
  data_region text NOT NULL DEFAULT 'eu',
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  oidc_subject text NOT NULL UNIQUE,
  email text NOT NULL,
  name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner','admin','editor','agent','viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  key_prefix text NOT NULL UNIQUE,
  key_hash text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('secret','public_widget')),
  scopes text[] NOT NULL DEFAULT '{}',
  allowed_origins text[] NOT NULL DEFAULT '{}',
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid,
  actor_user_id uuid,
  actor_api_key_id uuid,
  action text NOT NULL,
  resource text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'audit_log is append-only'; END
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
```

`api/drizzle/tenant/0001_init.sql` (NO schema qualifiers — search_path decides):
```sql
CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  default_language text NOT NULL DEFAULT 'nl',
  status text NOT NULL DEFAULT 'active',
  settings jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

- [ ] **Step 3: Write failing integration test**

`api/test/helpers/pg.ts`:
```ts
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';

export async function startPg(): Promise<{ container: StartedPostgreSqlContainer; pool: Pool }> {
  const container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  const pool = new Pool({ connectionString: container.getConnectionUri() });
  return { container, pool };
}
```

`api/test/migrator.integration.spec.ts`:
```ts
import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runMigrations, CONTROLPLANE_DIR } from '../src/db/migrator';
import { startPg } from './helpers/pg';

describe('migrator', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  beforeAll(async () => ({ container, pool } = await startPg()));
  afterAll(async () => { await pool.end(); await container.stop(); });

  it('applies control-plane migrations and is idempotent', async () => {
    const first = await runMigrations(pool, { dir: CONTROLPLANE_DIR, schema: 'public', track: 'controlplane' });
    expect(first).toEqual(['0001_init.sql']);
    const second = await runMigrations(pool, { dir: CONTROLPLANE_DIR, schema: 'public', track: 'controlplane' });
    expect(second).toEqual([]);
    const r = await pool.query(`SELECT count(*) FROM tenants`);
    expect(r.rows[0].count).toBe('0');
  });
});
```

- [ ] **Step 4: Run to verify failure** — `pnpm test:int` → FAIL (`migrator` not found).

- [ ] **Step 5: Implement `api/src/db/migrator.ts`**

```ts
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

export const CONTROLPLANE_DIR = join(__dirname, '..', '..', 'drizzle', 'controlplane');
export const TENANT_DIR = join(__dirname, '..', '..', 'drizzle', 'tenant');

const SCHEMA_RE = /^(public|t_[0-9a-f]{32})$/;

export async function runMigrations(
  pool: Pool,
  opts: { dir: string; schema: string; track: string },
): Promise<string[]> {
  if (!SCHEMA_RE.test(opts.schema)) throw new Error(`Invalid schema name: ${opts.schema}`);
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS public.migrations (
      track text NOT NULL, version text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (track, version))`);
    const files = readdirSync(opts.dir).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      await client.query('BEGIN');
      try {
        const seen = await client.query('SELECT 1 FROM public.migrations WHERE track = $1 AND version = $2', [opts.track, file]);
        if (seen.rowCount) { await client.query('ROLLBACK'); continue; }
        await client.query(`SET LOCAL search_path TO "${opts.schema}", public`);
        await client.query(readFileSync(join(opts.dir, file), 'utf8'));
        await client.query('INSERT INTO public.migrations (track, version) VALUES ($1, $2)', [opts.track, file]);
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
```

- [ ] **Step 6: Run tests** — `pnpm test:int` → PASS. Also `docker compose up -d postgres redis` from repo root to verify compose boots.
- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat(api): docker compose infra, dual-track SQL migrator, control-plane schema"`

---

### Task 3: Drizzle control-plane schema definitions + DB module

**Files:**
- Create: `api/src/db/schema.ts`, `api/src/db/db.module.ts`, `api/test/schema.integration.spec.ts`
- Modify: `api/src/app.module.ts` (import `DbModule`)

**Interfaces:**
- Produces: Drizzle table objects `tenants`, `users`, `memberships`, `apiKeys`, `auditLog` (exported from `schema.ts`, camelCase properties mapping to the SQL above). DI tokens: `PG_POOL` (pg `Pool`) and `DB` (`NodePgDatabase<typeof schema>`). `DbModule` is `@Global()`.

- [ ] **Step 1: Write failing integration test**

`api/test/schema.integration.spec.ts`:
```ts
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import * as schema from '../src/db/schema';
import { runMigrations, CONTROLPLANE_DIR } from '../src/db/migrator';
import { startPg } from './helpers/pg';

describe('control-plane schema', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  beforeAll(async () => {
    ({ container, pool } = await startPg());
    await runMigrations(pool, { dir: CONTROLPLANE_DIR, schema: 'public', track: 'controlplane' });
  });
  afterAll(async () => { await pool.end(); await container.stop(); });

  it('inserts and reads a tenant via drizzle', async () => {
    const db = drizzle(pool, { schema });
    const [t] = await db.insert(schema.tenants)
      .values({ name: 'Acme', slug: 'acme', schemaName: 't_' + 'a'.repeat(32) })
      .returning();
    expect(t.plan).toBe('starter');
    expect(t.dataRegion).toBe('eu');
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm test:int -- --testPathPattern schema` → FAIL.

- [ ] **Step 3: Implement `api/src/db/schema.ts`**

```ts
import { bigint, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  schemaName: text('schema_name').notNull().unique(),
  plan: text('plan').notNull().default('starter'),
  dataRegion: text('data_region').notNull().default('eu'),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  oidcSubject: text('oidc_subject').notNull().unique(),
  email: text('email').notNull(),
  name: text('name'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const memberships = pgTable('memberships', {
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: text('role', { enum: ['owner', 'admin', 'editor', 'agent', 'viewer'] }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.tenantId, t.userId] })]);

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  keyPrefix: text('key_prefix').notNull().unique(),
  keyHash: text('key_hash').notNull(),
  kind: text('kind', { enum: ['secret', 'public_widget'] }).notNull(),
  scopes: text('scopes').array().notNull().default([]),
  allowedOrigins: text('allowed_origins').array().notNull().default([]),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const auditLog = pgTable('audit_log', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  tenantId: uuid('tenant_id'),
  actorUserId: uuid('actor_user_id'),
  actorApiKeyId: uuid('actor_api_key_id'),
  action: text('action').notNull(),
  resource: text('resource').notNull(),
  metadata: jsonb('metadata').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Role = (typeof memberships.$inferSelect)['role'];
```

`api/src/db/db.module.ts`:
```ts
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
    { provide: PG_POOL, useFactory: (cfg: AppConfig) => new Pool({ connectionString: cfg.databaseUrl }), inject: [APP_CONFIG] },
    { provide: DB, useFactory: (pool: Pool) => drizzle(pool, { schema }), inject: [PG_POOL] },
  ],
  exports: [APP_CONFIG, PG_POOL, DB],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
```

Update `api/src/app.module.ts`: remove the inline `APP_CONFIG` provider, add `imports: [DbModule]` (DbModule now provides/exports `APP_CONFIG`).

- [ ] **Step 4: Run tests** — `pnpm test:int -- --testPathPattern schema` → PASS; `pnpm test` still green.
- [ ] **Step 5: Commit** — `git commit -am "feat(api): drizzle control-plane schema and global db module"`

---

### Task 4: Tenant provisioning service (create schema + run tenant track)

**Files:**
- Create: `api/src/tenancy/tenancy.module.ts`, `api/src/tenancy/tenant-provisioning.service.ts`, `api/test/tenant-provisioning.integration.spec.ts`

**Interfaces:**
- Consumes: `PG_POOL`, `DB`, `runMigrations`, `TENANT_DIR`, `schema.tenants`.
- Produces: `TenantProvisioningService.createTenant(input: { name: string; slug: string }): Promise<{ id: string; slug: string; schemaName: string }>` — inserts tenant row, creates schema, runs tenant migration track. Throws `ConflictException` on duplicate slug.

- [ ] **Step 1: Write failing integration test**

`api/test/tenant-provisioning.integration.spec.ts`:
```ts
import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { TenantProvisioningService } from '../src/tenancy/tenant-provisioning.service';
import { runMigrations, CONTROLPLANE_DIR } from '../src/db/migrator';
import * as schema from '../src/db/schema';
import { startPg } from './helpers/pg';

describe('TenantProvisioningService', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let svc: TenantProvisioningService;
  beforeAll(async () => {
    ({ container, pool } = await startPg());
    await runMigrations(pool, { dir: CONTROLPLANE_DIR, schema: 'public', track: 'controlplane' });
    svc = new TenantProvisioningService(pool, drizzle(pool, { schema }));
  });
  afterAll(async () => { await pool.end(); await container.stop(); });

  it('creates tenant row, schema, and tenant tables', async () => {
    const t = await svc.createTenant({ name: 'Acme', slug: 'acme' });
    expect(t.schemaName).toMatch(/^t_[0-9a-f]{32}$/);
    const r = await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'projects'`,
      [t.schemaName],
    );
    expect(r.rowCount).toBe(1);
  });

  it('rejects duplicate slug', async () => {
    await expect(svc.createTenant({ name: 'Acme2', slug: 'acme' })).rejects.toThrow(/already exists/i);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm test:int -- --testPathPattern tenant-provisioning` → FAIL.

- [ ] **Step 3: Implement**

`api/src/tenancy/tenant-provisioning.service.ts`:
```ts
import { randomBytes } from 'node:crypto';
import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { Db, DB, PG_POOL } from '../db/db.module';
import { runMigrations, TENANT_DIR } from '../db/migrator';
import { tenants } from '../db/schema';

export interface CreatedTenant { id: string; slug: string; schemaName: string }

@Injectable()
export class TenantProvisioningService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(DB) private readonly db: Db,
  ) {}

  async createTenant(input: { name: string; slug: string }): Promise<CreatedTenant> {
    const existing = await this.db.select().from(tenants).where(eq(tenants.slug, input.slug));
    if (existing.length > 0) throw new ConflictException(`Tenant slug '${input.slug}' already exists`);

    const schemaName = `t_${randomBytes(16).toString('hex')}`;
    const [row] = await this.db.insert(tenants)
      .values({ name: input.name, slug: input.slug, schemaName })
      .returning();
    await this.pool.query(`CREATE SCHEMA "${schemaName}"`);
    await runMigrations(this.pool, { dir: TENANT_DIR, schema: schemaName, track: `tenant:${schemaName}` });
    return { id: row.id, slug: row.slug, schemaName: row.schemaName };
  }
}
```

`api/src/tenancy/tenancy.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { TenantProvisioningService } from './tenant-provisioning.service';
import { TenantDbService } from './tenant-db.service';

@Module({
  providers: [TenantProvisioningService, TenantDbService],
  exports: [TenantProvisioningService, TenantDbService],
})
export class TenancyModule {}
```
(`TenantDbService` arrives in Task 5 — create it as an empty `@Injectable() export class TenantDbService {}` stub in `api/src/tenancy/tenant-db.service.ts` now so the module compiles.)

- [ ] **Step 4: Run tests** — `pnpm test:int -- --testPathPattern tenant-provisioning` → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(api): tenant provisioning with schema-per-tenant migration track"`

---

### Task 5: Tenant-scoped DB access + cross-tenant isolation proof

**Files:**
- Modify: `api/src/tenancy/tenant-db.service.ts` (replace stub)
- Create: `api/test/tenant-isolation.integration.spec.ts`

**Interfaces:**
- Consumes: `PG_POOL`.
- Produces: `TenantDbService.withTenant<T>(schemaName: string, fn: (db: NodePgDatabase) => Promise<T>): Promise<T>` — opens a transaction, `SET LOCAL search_path TO "<schema>", public`, runs `fn` with a drizzle instance bound to that connection, commits (rolls back on throw). Validates schema name against `/^t_[0-9a-f]{32}$/` (throws `Error('Invalid tenant schema')`). Every later phase uses this for ALL tenant-scoped queries.

- [ ] **Step 1: Write failing integration test**

`api/test/tenant-isolation.integration.spec.ts`:
```ts
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { TenantProvisioningService } from '../src/tenancy/tenant-provisioning.service';
import { TenantDbService } from '../src/tenancy/tenant-db.service';
import { runMigrations, CONTROLPLANE_DIR } from '../src/db/migrator';
import * as schema from '../src/db/schema';
import { startPg } from './helpers/pg';

describe('tenant isolation', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let tenantDb: TenantDbService;
  let a: { schemaName: string };
  let b: { schemaName: string };

  beforeAll(async () => {
    ({ container, pool } = await startPg());
    await runMigrations(pool, { dir: CONTROLPLANE_DIR, schema: 'public', track: 'controlplane' });
    const prov = new TenantProvisioningService(pool, drizzle(pool, { schema }));
    a = await prov.createTenant({ name: 'A', slug: 'a' });
    b = await prov.createTenant({ name: 'B', slug: 'b' });
    tenantDb = new TenantDbService(pool);
  });
  afterAll(async () => { await pool.end(); await container.stop(); });

  it('data written in tenant A is invisible in tenant B', async () => {
    await tenantDb.withTenant(a.schemaName, async (db) => {
      await db.execute(sql`INSERT INTO projects (name) VALUES ('secret-a')`);
    });
    const inB = await tenantDb.withTenant(b.schemaName, (db) =>
      db.execute(sql`SELECT * FROM projects`),
    );
    expect(inB.rows).toHaveLength(0);
    const inA = await tenantDb.withTenant(a.schemaName, (db) =>
      db.execute(sql`SELECT name FROM projects`),
    );
    expect(inA.rows).toEqual([{ name: 'secret-a' }]);
  });

  it('rolls back on error', async () => {
    await expect(tenantDb.withTenant(a.schemaName, async (db) => {
      await db.execute(sql`INSERT INTO projects (name) VALUES ('doomed')`);
      throw new Error('boom');
    })).rejects.toThrow('boom');
    const rows = await tenantDb.withTenant(a.schemaName, (db) =>
      db.execute(sql`SELECT * FROM projects WHERE name = 'doomed'`),
    );
    expect(rows.rows).toHaveLength(0);
  });

  it('rejects malformed schema names', async () => {
    await expect(tenantDb.withTenant('public; DROP TABLE tenants;--', async () => undefined))
      .rejects.toThrow('Invalid tenant schema');
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm test:int -- --testPathPattern tenant-isolation` → FAIL (stub has no `withTenant`).

- [ ] **Step 3: Implement `api/src/tenancy/tenant-db.service.ts`**

```ts
import { Inject, Injectable } from '@nestjs/common';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { PG_POOL } from '../db/db.module';

const TENANT_SCHEMA_RE = /^t_[0-9a-f]{32}$/;

@Injectable()
export class TenantDbService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async withTenant<T>(schemaName: string, fn: (db: NodePgDatabase) => Promise<T>): Promise<T> {
    if (!TENANT_SCHEMA_RE.test(schemaName)) throw new Error('Invalid tenant schema');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL search_path TO "${schemaName}", public`);
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
```

- [ ] **Step 4: Run tests** — `pnpm test:int -- --testPathPattern tenant-isolation` → 3 PASS. This is the compliance-critical test of the phase.
- [ ] **Step 5: Commit** — `git commit -am "feat(api): tenant-scoped db access with proven cross-tenant isolation"`

---

### Task 6: OIDC JWT verification + AuthGuard + user mirroring

**Files:**
- Create: `api/src/auth/auth.module.ts`, `api/src/auth/oidc.verifier.ts`, `api/src/auth/auth.guard.ts`, `api/src/auth/users.service.ts`, `api/src/auth/auth.types.ts`, `api/src/auth/public.decorator.ts`, `api/test/helpers/oidc.ts`, `api/src/auth/auth.guard.spec.ts`

**Interfaces:**
- Consumes: `APP_CONFIG`, `DB`, `schema.users`.
- Produces: DI token `JWT_KEY_GETTER` (type `jose.JWTVerifyGetKey`; default: `createRemoteJWKSet(new URL(cfg.oidcJwksUrl))`; tests override). `OidcVerifier.verify(token: string): Promise<{ sub: string; email: string; name?: string }>`. `UsersService.upsertFromClaims(claims): Promise<{ id: string; email: string }>`. `AuthGuard` (global `APP_GUARD`): validates `Authorization: Bearer`, attaches `req.user: AuthUser = { id: string; oidcSubject: string; email: string }`; `@Public()` decorator skips it (health stays public). `CurrentUser()` param decorator.

- [ ] **Step 1: Write test helper `api/test/helpers/oidc.ts`**

```ts
import { createLocalJWKSet, exportJWK, generateKeyPair, JWTVerifyGetKey, SignJWT } from 'jose';

export interface TestIdp {
  keyGetter: JWTVerifyGetKey;
  sign(claims: { sub: string; email: string; name?: string }, opts?: { issuer?: string; audience?: string; expired?: boolean }): Promise<string>;
}

export const TEST_ISSUER = 'https://id.example.eu';
export const TEST_AUDIENCE = 'bonsai-api';

export async function makeTestIdp(): Promise<TestIdp> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key';
  jwk.alg = 'RS256';
  const keyGetter = createLocalJWKSet({ keys: [jwk] });
  return {
    keyGetter,
    async sign(claims, opts = {}) {
      return new SignJWT({ email: claims.email, name: claims.name })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setSubject(claims.sub)
        .setIssuer(opts.issuer ?? TEST_ISSUER)
        .setAudience(opts.audience ?? TEST_AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(opts.expired ? '-1h' : '1h')
        .sign(privateKey);
    },
  };
}
```

- [ ] **Step 2: Write failing unit test `api/src/auth/auth.guard.spec.ts`**

```ts
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { OidcVerifier } from './oidc.verifier';
import { AuthGuard } from './auth.guard';
import { makeTestIdp, TEST_AUDIENCE, TEST_ISSUER, TestIdp } from '../../test/helpers/oidc';

function ctxWithAuth(header?: string): ExecutionContext {
  const req: Record<string, unknown> = { headers: header ? { authorization: header } : {} };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

describe('AuthGuard', () => {
  let idp: TestIdp;
  let guard: AuthGuard;
  const upserted = { id: 'user-1', email: 'a@b.eu' };
  const usersService = { upsertFromClaims: jest.fn().mockResolvedValue(upserted) };

  beforeAll(async () => {
    idp = await makeTestIdp();
    const verifier = new OidcVerifier(idp.keyGetter, {
      oidcIssuer: TEST_ISSUER, oidcAudience: TEST_AUDIENCE,
    } as never);
    guard = new AuthGuard(verifier, usersService as never, new Reflector());
  });

  it('accepts a valid token and attaches req.user', async () => {
    const token = await idp.sign({ sub: 'oidc|1', email: 'a@b.eu' });
    const ctx = ctxWithAuth(`Bearer ${token}`);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    const req = ctx.switchToHttp().getRequest<{ user: { id: string; oidcSubject: string } }>();
    expect(req.user).toEqual({ id: 'user-1', oidcSubject: 'oidc|1', email: 'a@b.eu' });
  });

  it('rejects a missing header', async () => {
    await expect(guard.canActivate(ctxWithAuth())).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a wrong-issuer token', async () => {
    const token = await idp.sign({ sub: 'oidc|1', email: 'a@b.eu' }, { issuer: 'https://evil.example' });
    await expect(guard.canActivate(ctxWithAuth(`Bearer ${token}`))).rejects.toThrow(UnauthorizedException);
  });

  it('rejects an expired token', async () => {
    const token = await idp.sign({ sub: 'oidc|1', email: 'a@b.eu' }, { expired: true });
    await expect(guard.canActivate(ctxWithAuth(`Bearer ${token}`))).rejects.toThrow(UnauthorizedException);
  });
});
```

- [ ] **Step 3: Run to verify failure** — `pnpm test -- --testPathPattern auth.guard` → FAIL.

- [ ] **Step 4: Implement**

`api/src/auth/auth.types.ts`:
```ts
import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface AuthUser { id: string; oidcSubject: string; email: string }

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest<{ user: AuthUser }>().user;
});
```

`api/src/auth/public.decorator.ts`:
```ts
import { SetMetadata } from '@nestjs/common';
export const IS_PUBLIC = 'isPublic';
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);
```

`api/src/auth/oidc.verifier.ts`:
```ts
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JWTVerifyGetKey, jwtVerify } from 'jose';
import { APP_CONFIG, AppConfig } from '../config/config';

export const JWT_KEY_GETTER = Symbol('JWT_KEY_GETTER');

export interface VerifiedClaims { sub: string; email: string; name?: string }

@Injectable()
export class OidcVerifier {
  constructor(
    @Inject(JWT_KEY_GETTER) private readonly keyGetter: JWTVerifyGetKey,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  async verify(token: string): Promise<VerifiedClaims> {
    try {
      const { payload } = await jwtVerify(token, this.keyGetter, {
        issuer: this.cfg.oidcIssuer,
        audience: this.cfg.oidcAudience,
      });
      if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') {
        throw new Error('missing claims');
      }
      return { sub: payload.sub, email: payload.email, name: typeof payload.name === 'string' ? payload.name : undefined };
    } catch {
      throw new UnauthorizedException('Invalid token');
    }
  }
}
```

`api/src/auth/users.service.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Db, DB } from '../db/db.module';
import { users } from '../db/schema';
import { VerifiedClaims } from './oidc.verifier';

@Injectable()
export class UsersService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async upsertFromClaims(claims: VerifiedClaims): Promise<{ id: string; email: string }> {
    const [row] = await this.db.insert(users)
      .values({ oidcSubject: claims.sub, email: claims.email, name: claims.name })
      .onConflictDoUpdate({
        target: users.oidcSubject,
        set: { email: claims.email, name: sql`COALESCE(EXCLUDED.name, users.name)` },
      })
      .returning();
    return { id: row.id, email: row.email };
  }
}
```

`api/src/auth/auth.guard.ts`:
```ts
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthUser } from './auth.types';
import { OidcVerifier } from './oidc.verifier';
import { IS_PUBLIC } from './public.decorator';
import { UsersService } from './users.service';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly verifier: OidcVerifier,
    private readonly usersService: UsersService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest<{ headers: Record<string, string | undefined>; user?: AuthUser }>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Missing bearer token');
    const claims = await this.verifier.verify(header.slice('Bearer '.length));
    const user = await this.usersService.upsertFromClaims(claims);
    req.user = { id: user.id, oidcSubject: claims.sub, email: user.email };
    return true;
  }
}
```

`api/src/auth/auth.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { createRemoteJWKSet } from 'jose';
import { APP_CONFIG, AppConfig } from '../config/config';
import { AuthGuard } from './auth.guard';
import { JWT_KEY_GETTER, OidcVerifier } from './oidc.verifier';
import { UsersService } from './users.service';

@Module({
  providers: [
    { provide: JWT_KEY_GETTER, useFactory: (cfg: AppConfig) => createRemoteJWKSet(new URL(cfg.oidcJwksUrl)), inject: [APP_CONFIG] },
    OidcVerifier,
    UsersService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [OidcVerifier, UsersService],
})
export class AuthModule {}
```

Add `AuthModule` and `TenancyModule` to `AppModule` imports; add `@Public()` to `HealthController.check()`.

- [ ] **Step 5: Run tests** — `pnpm test -- --testPathPattern auth.guard` → 4 PASS; full `pnpm test` green.
- [ ] **Step 6: Commit** — `git commit -am "feat(api): OIDC jwt verification, global auth guard, user mirroring"`

---

### Task 7: Memberships + RBAC guard

**Files:**
- Create: `api/src/auth/roles.decorator.ts`, `api/src/auth/membership.guard.ts`, `api/src/auth/memberships.service.ts`, `api/src/auth/membership.guard.spec.ts`

**Interfaces:**
- Consumes: `DB`, `schema.memberships`, `schema.tenants`, `req.user` from Task 6.
- Produces: `@RequireRole('admin')` decorator (metadata key `requiredRole`); `MembershipGuard` — for routes containing `:tenantId`, loads membership + tenant, enforces role rank ≥ required, attaches `req.membership: { role: Role }` and `req.tenant: { id: string; schemaName: string }`. `MembershipsService.find(tenantId, userId): Promise<{ role: Role; tenant: { id: string; schemaName: string } } | null>` and `MembershipsService.add(tenantId, userId, role): Promise<void>`. `ROLE_RANK: Record<Role, number>`.

- [ ] **Step 1: Write failing unit test `api/src/auth/membership.guard.spec.ts`**

```ts
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MembershipGuard } from './membership.guard';
import { REQUIRED_ROLE } from './roles.decorator';

function ctx(params: Record<string, string>, requiredRole?: string): ExecutionContext {
  const req: Record<string, unknown> = { params, user: { id: 'u1' } };
  const handler = (): void => undefined;
  Reflect.defineMetadata(REQUIRED_ROLE, requiredRole, handler);
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => handler,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

describe('MembershipGuard', () => {
  const tenant = { id: 't1', schemaName: 't_' + 'a'.repeat(32) };
  const svc = { find: jest.fn() };
  const guard = new MembershipGuard(svc as never, new Reflector());

  it('allows a member with sufficient role and attaches tenant', async () => {
    svc.find.mockResolvedValue({ role: 'admin', tenant });
    const c = ctx({ tenantId: 't1' }, 'editor');
    await expect(guard.canActivate(c)).resolves.toBe(true);
    const req = c.switchToHttp().getRequest<{ tenant: unknown; membership: unknown }>();
    expect(req.tenant).toEqual(tenant);
    expect(req.membership).toEqual({ role: 'admin' });
  });

  it('denies insufficient role', async () => {
    svc.find.mockResolvedValue({ role: 'viewer', tenant });
    await expect(guard.canActivate(ctx({ tenantId: 't1' }, 'admin'))).rejects.toThrow(ForbiddenException);
  });

  it('denies non-members', async () => {
    svc.find.mockResolvedValue(null);
    await expect(guard.canActivate(ctx({ tenantId: 't1' }, 'viewer'))).rejects.toThrow(ForbiddenException);
  });

  it('passes through routes without :tenantId', async () => {
    await expect(guard.canActivate(ctx({}, undefined))).resolves.toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm test -- --testPathPattern membership.guard` → FAIL.

- [ ] **Step 3: Implement**

`api/src/auth/roles.decorator.ts`:
```ts
import { SetMetadata } from '@nestjs/common';
import { Role } from '../db/schema';

export const REQUIRED_ROLE = 'requiredRole';
export const ROLE_RANK: Record<Role, number> = { owner: 5, admin: 4, editor: 3, agent: 2, viewer: 1 };
export const RequireRole = (role: Role): MethodDecorator & ClassDecorator => SetMetadata(REQUIRED_ROLE, role);
```

`api/src/auth/memberships.service.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { Db, DB } from '../db/db.module';
import { memberships, Role, tenants } from '../db/schema';

export interface MembershipWithTenant { role: Role; tenant: { id: string; schemaName: string } }

@Injectable()
export class MembershipsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async find(tenantId: string, userId: string): Promise<MembershipWithTenant | null> {
    const rows = await this.db
      .select({ role: memberships.role, id: tenants.id, schemaName: tenants.schemaName })
      .from(memberships)
      .innerJoin(tenants, eq(memberships.tenantId, tenants.id))
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)));
    const row = rows[0];
    return row ? { role: row.role, tenant: { id: row.id, schemaName: row.schemaName } } : null;
  }

  async add(tenantId: string, userId: string, role: Role): Promise<void> {
    await this.db.insert(memberships).values({ tenantId, userId, role });
  }
}
```

`api/src/auth/membership.guard.ts`:
```ts
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '../db/schema';
import { AuthUser } from './auth.types';
import { MembershipsService } from './memberships.service';
import { REQUIRED_ROLE, ROLE_RANK } from './roles.decorator';

@Injectable()
export class MembershipGuard implements CanActivate {
  constructor(
    private readonly membershipsService: MembershipsService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<{
      params: Record<string, string | undefined>;
      user: AuthUser;
      membership?: { role: Role };
      tenant?: { id: string; schemaName: string };
    }>();
    const tenantId = req.params.tenantId;
    if (!tenantId) return true;
    const membership = await this.membershipsService.find(tenantId, req.user.id);
    if (!membership) throw new ForbiddenException('Not a member of this tenant');
    const required = this.reflector.getAllAndOverride<Role | undefined>(REQUIRED_ROLE, [ctx.getHandler(), ctx.getClass()]) ?? 'viewer';
    if (ROLE_RANK[membership.role] < ROLE_RANK[required]) {
      throw new ForbiddenException(`Requires role ${required}`);
    }
    req.membership = { role: membership.role };
    req.tenant = membership.tenant;
    return true;
  }
}
```

Register in `AuthModule` providers: `MembershipsService` and `{ provide: APP_GUARD, useClass: MembershipGuard }` (AFTER the AuthGuard provider — global guards run in registration order). Export `MembershipsService`.

- [ ] **Step 4: Run tests** — `pnpm test -- --testPathPattern membership.guard` → 4 PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(api): membership rbac guard with role hierarchy"`

---

### Task 8: Audit log service

**Files:**
- Create: `api/src/audit/audit.module.ts`, `api/src/audit/audit.service.ts`, `api/test/audit.integration.spec.ts`

**Interfaces:**
- Consumes: `DB`, `schema.auditLog` (table + trigger exist from Task 2).
- Produces: `AuditService.record(entry: { tenantId?: string; actorUserId?: string; actorApiKeyId?: string; action: string; resource: string; metadata?: Record<string, unknown> }): Promise<void>`. `AuditModule` is `@Global()` and exports `AuditService`. Action naming convention: `<domain>.<verb>` (e.g. `tenant.created`, `project.deleted`, `api_key.revoked`, `member.added`).

- [ ] **Step 1: Write failing integration test `api/test/audit.integration.spec.ts`**

```ts
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { AuditService } from '../src/audit/audit.service';
import { runMigrations, CONTROLPLANE_DIR } from '../src/db/migrator';
import * as schema from '../src/db/schema';
import { startPg } from './helpers/pg';

describe('AuditService', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let svc: AuditService;
  beforeAll(async () => {
    ({ container, pool } = await startPg());
    await runMigrations(pool, { dir: CONTROLPLANE_DIR, schema: 'public', track: 'controlplane' });
    svc = new AuditService(drizzle(pool, { schema }));
  });
  afterAll(async () => { await pool.end(); await container.stop(); });

  it('records an audit entry', async () => {
    await svc.record({ action: 'tenant.created', resource: 'tenant:x', metadata: { slug: 'x' } });
    const r = await pool.query(`SELECT action, resource, metadata FROM audit_log`);
    expect(r.rows).toEqual([{ action: 'tenant.created', resource: 'tenant:x', metadata: { slug: 'x' } }]);
  });

  it('audit_log rejects UPDATE and DELETE (append-only)', async () => {
    await expect(pool.query(`UPDATE audit_log SET action = 'tampered'`)).rejects.toThrow(/append-only/);
    await expect(pool.query(`DELETE FROM audit_log`)).rejects.toThrow(/append-only/);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm test:int -- --testPathPattern audit` → FAIL.

- [ ] **Step 3: Implement**

`api/src/audit/audit.service.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import { Db, DB } from '../db/db.module';
import { auditLog } from '../db/schema';

export interface AuditEntry {
  tenantId?: string;
  actorUserId?: string;
  actorApiKeyId?: string;
  action: string;
  resource: string;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.db.insert(auditLog).values({
      tenantId: entry.tenantId,
      actorUserId: entry.actorUserId,
      actorApiKeyId: entry.actorApiKeyId,
      action: entry.action,
      resource: entry.resource,
      metadata: entry.metadata ?? {},
    });
  }
}
```

`api/src/audit/audit.module.ts`:
```ts
import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';

@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
```

Add `AuditModule` to `AppModule` imports.

- [ ] **Step 4: Run tests** — `pnpm test:int -- --testPathPattern audit` → 2 PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(api): append-only audit log service"`

---

### Task 9: Tenants + members REST endpoints (e2e)

**Files:**
- Create: `api/src/tenants/tenants.module.ts`, `api/src/tenants/tenants.controller.ts`, `api/src/tenants/tenants.service.ts`, `api/src/tenants/dto.ts`, `api/test/tenants.e2e.integration.spec.ts`, `api/test/helpers/app.ts`
- Modify: `api/src/app.module.ts`

**Interfaces:**
- Consumes: `TenantProvisioningService`, `MembershipsService`, `AuditService`, `DB`, `AuthUser`, test helpers from Tasks 2/6.
- Produces: `POST /v1/tenants {name, slug}` → 201 `{id, name, slug}` (creator becomes owner; audited `tenant.created`); `GET /v1/tenants` → tenants where caller is a member `[{id, name, slug, role}]`; `POST /v1/tenants/:tenantId/members {email, role}` (RequireRole admin; 404 if no user with that email; audited `member.added`). Test helper `buildTestApp(pool): Promise<{ app: INestApplication; idp: TestIdp }>` that overrides `JWT_KEY_GETTER` + `APP_CONFIG` and runs both migration tracks.

- [ ] **Step 1: Write helper `api/test/helpers/app.ts`**

```ts
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { AppModule } from '../../src/app.module';
import { APP_CONFIG, AppConfig } from '../../src/config/config';
import { PG_POOL } from '../../src/db/db.module';
import { JWT_KEY_GETTER } from '../../src/auth/oidc.verifier';
import { CONTROLPLANE_DIR, runMigrations } from '../../src/db/migrator';
import { makeTestIdp, TEST_AUDIENCE, TEST_ISSUER, TestIdp } from './oidc';

export async function buildTestApp(pool: Pool): Promise<{ app: INestApplication; idp: TestIdp }> {
  await runMigrations(pool, { dir: CONTROLPLANE_DIR, schema: 'public', track: 'controlplane' });
  const idp = await makeTestIdp();
  const cfg: AppConfig = {
    databaseUrl: 'overridden', port: 0, nodeEnv: 'test',
    oidcIssuer: TEST_ISSUER, oidcAudience: TEST_AUDIENCE, oidcJwksUrl: 'https://unused.example/keys',
  };
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG).useValue(cfg)
    .overrideProvider(PG_POOL).useValue(pool)
    .overrideProvider(JWT_KEY_GETTER).useValue(idp.keyGetter)
    .compile();
  const app = mod.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.setGlobalPrefix('v1', { exclude: ['health'] });
  await app.init();
  return { app, idp };
}
```

Note: `PG_POOL` override replaces the pool app-wide, so `DB` (built from `PG_POOL`) hits the test container too — but ONLY if `DB`'s factory uses the injected pool (it does, Task 3).

- [ ] **Step 2: Write failing e2e test `api/test/tenants.e2e.integration.spec.ts`**

```ts
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPg } from './helpers/pg';
import { buildTestApp } from './helpers/app';
import { TestIdp } from './helpers/oidc';

describe('tenants e2e', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let idp: TestIdp;
  let ownerToken: string;
  let strangerToken: string;

  beforeAll(async () => {
    ({ container, pool } = await startPg());
    ({ app, idp } = await buildTestApp(pool));
    ownerToken = await idp.sign({ sub: 'oidc|owner', email: 'owner@acme.eu' });
    strangerToken = await idp.sign({ sub: 'oidc|stranger', email: 'stranger@x.eu' });
  });
  afterAll(async () => { await app.close(); await container.stop(); });

  it('rejects unauthenticated tenant creation', async () => {
    await request(app.getHttpServer()).post('/v1/tenants').send({ name: 'A', slug: 'a' }).expect(401);
  });

  it('creates a tenant; creator becomes owner; audit written', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/tenants').set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'Acme', slug: 'acme' }).expect(201);
    expect(res.body).toMatchObject({ name: 'Acme', slug: 'acme' });

    const list = await request(app.getHttpServer())
      .get('/v1/tenants').set('Authorization', `Bearer ${ownerToken}`).expect(200);
    expect(list.body).toEqual([expect.objectContaining({ slug: 'acme', role: 'owner' })]);

    const audit = await pool.query(`SELECT action FROM audit_log WHERE action = 'tenant.created'`);
    expect(audit.rowCount).toBe(1);
  });

  it('non-members cannot list the tenant or add members', async () => {
    const list = await request(app.getHttpServer())
      .get('/v1/tenants').set('Authorization', `Bearer ${strangerToken}`).expect(200);
    expect(list.body).toEqual([]);

    const { rows: [t] } = await pool.query(`SELECT id FROM tenants WHERE slug = 'acme'`);
    await request(app.getHttpServer())
      .post(`/v1/tenants/${t.id}/members`).set('Authorization', `Bearer ${strangerToken}`)
      .send({ email: 'stranger@x.eu', role: 'admin' }).expect(403);
  });

  it('owner adds an existing user as member', async () => {
    const { rows: [t] } = await pool.query(`SELECT id FROM tenants WHERE slug = 'acme'`);
    await request(app.getHttpServer())
      .post(`/v1/tenants/${t.id}/members`).set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'stranger@x.eu', role: 'agent' }).expect(201);
    const list = await request(app.getHttpServer())
      .get('/v1/tenants').set('Authorization', `Bearer ${strangerToken}`).expect(200);
    expect(list.body).toEqual([expect.objectContaining({ slug: 'acme', role: 'agent' })]);
  });

  it('404s when adding a member whose email has never logged in', async () => {
    const { rows: [t] } = await pool.query(`SELECT id FROM tenants WHERE slug = 'acme'`);
    await request(app.getHttpServer())
      .post(`/v1/tenants/${t.id}/members`).set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'ghost@x.eu', role: 'agent' }).expect(404);
  });
});
```

- [ ] **Step 3: Run to verify failure** — `pnpm test:int -- --testPathPattern tenants.e2e` → FAIL (no controller).

- [ ] **Step 4: Implement**

`api/src/tenants/dto.ts`:
```ts
import { IsEmail, IsIn, IsString, Length, Matches } from 'class-validator';
import { Role } from '../db/schema';

export class CreateTenantDto {
  @IsString() @Length(2, 100) name!: string;
  @Matches(/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/) slug!: string;
}

export class AddMemberDto {
  @IsEmail() email!: string;
  @IsIn(['admin', 'editor', 'agent', 'viewer']) role!: Exclude<Role, 'owner'>;
}
```
(Requires `pnpm add class-validator class-transformer` if the scaffold didn't include them.)

`api/src/tenants/tenants.service.ts`:
```ts
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { MembershipsService } from '../auth/memberships.service';
import { Db, DB } from '../db/db.module';
import { memberships, Role, tenants, users } from '../db/schema';
import { TenantProvisioningService } from '../tenancy/tenant-provisioning.service';

@Injectable()
export class TenantsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly provisioning: TenantProvisioningService,
    private readonly membershipsService: MembershipsService,
    private readonly audit: AuditService,
  ) {}

  async create(input: { name: string; slug: string }, actorUserId: string): Promise<{ id: string; name: string; slug: string }> {
    const t = await this.provisioning.createTenant(input);
    await this.membershipsService.add(t.id, actorUserId, 'owner');
    await this.audit.record({ tenantId: t.id, actorUserId, action: 'tenant.created', resource: `tenant:${t.id}`, metadata: { slug: t.slug } });
    return { id: t.id, name: input.name, slug: t.slug };
  }

  async listForUser(userId: string): Promise<Array<{ id: string; name: string; slug: string; role: Role }>> {
    return this.db
      .select({ id: tenants.id, name: tenants.name, slug: tenants.slug, role: memberships.role })
      .from(memberships)
      .innerJoin(tenants, eq(memberships.tenantId, tenants.id))
      .where(eq(memberships.userId, userId));
  }

  async addMemberByEmail(tenantId: string, email: string, role: Role, actorUserId: string): Promise<void> {
    const [user] = await this.db.select().from(users).where(eq(users.email, email));
    if (!user) throw new NotFoundException(`No user with email ${email} — they must log in once first`);
    await this.membershipsService.add(tenantId, user.id, role);
    await this.audit.record({ tenantId, actorUserId, action: 'member.added', resource: `user:${user.id}`, metadata: { role } });
  }
}
```

`api/src/tenants/tenants.controller.ts`:
```ts
import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../auth/auth.types';
import { RequireRole } from '../auth/roles.decorator';
import { AddMemberDto, CreateTenantDto } from './dto';
import { TenantsService } from './tenants.service';

@Controller('tenants')
export class TenantsController {
  constructor(private readonly tenantsService: TenantsService) {}

  @Post()
  create(@Body() dto: CreateTenantDto, @CurrentUser() user: AuthUser) {
    return this.tenantsService.create(dto, user.id);
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.tenantsService.listForUser(user.id);
  }

  @Post(':tenantId/members')
  @RequireRole('admin')
  async addMember(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body() dto: AddMemberDto,
    @CurrentUser() user: AuthUser,
  ): Promise<{ ok: true }> {
    await this.tenantsService.addMemberByEmail(tenantId, dto.email, dto.role, user.id);
    return { ok: true };
  }
}
```

`api/src/tenants/tenants.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { TenantsController } from './tenants.controller';
import { TenantsService } from './tenants.service';

@Module({
  imports: [AuthModule, TenancyModule],
  controllers: [TenantsController],
  providers: [TenantsService],
})
export class TenantsModule {}
```

Add `TenantsModule` to `AppModule`. In `api/src/main.ts` add the same `ValidationPipe` + `setGlobalPrefix('v1', { exclude: ['health'] })` as the test helper.

- [ ] **Step 5: Run tests** — `pnpm test:int -- --testPathPattern tenants.e2e` → 5 PASS.
- [ ] **Step 6: Commit** — `git commit -am "feat(api): tenant creation, listing, membership endpoints with audit"`

---

### Task 10: Projects CRUD in tenant schema (e2e)

**Files:**
- Create: `api/src/projects/projects.module.ts`, `api/src/projects/projects.controller.ts`, `api/src/projects/projects.service.ts`, `api/src/projects/dto.ts`, `api/test/projects.e2e.integration.spec.ts`

**Interfaces:**
- Consumes: `TenantDbService.withTenant`, `req.tenant.schemaName` (attached by MembershipGuard), `AuditService`.
- Produces: under `/v1/tenants/:tenantId/projects` — `POST {name, defaultLanguage?}` (RequireRole editor) → 201 project; `GET` (viewer) → list; `GET /:projectId` (viewer); `PATCH /:projectId {name?, defaultLanguage?}` (editor); `DELETE /:projectId` (admin, audited `project.deleted`). Project shape: `{ id, name, defaultLanguage, status, settings, createdAt, updatedAt }`. `Tenant()` param decorator returning `req.tenant`.

- [ ] **Step 1: Write failing e2e test `api/test/projects.e2e.integration.spec.ts`**

```ts
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPg } from './helpers/pg';
import { buildTestApp } from './helpers/app';
import { TestIdp } from './helpers/oidc';

describe('projects e2e', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let idp: TestIdp;
  let token: string;
  let tenantId: string;
  let otherTenantId: string;

  beforeAll(async () => {
    ({ container, pool } = await startPg());
    ({ app, idp } = await buildTestApp(pool));
    token = await idp.sign({ sub: 'oidc|u1', email: 'u1@acme.eu' });
    const t1 = await request(app.getHttpServer()).post('/v1/tenants')
      .set('Authorization', `Bearer ${token}`).send({ name: 'T1', slug: 't1' }).expect(201);
    tenantId = t1.body.id;
    const otherToken = await idp.sign({ sub: 'oidc|u2', email: 'u2@other.eu' });
    const t2 = await request(app.getHttpServer()).post('/v1/tenants')
      .set('Authorization', `Bearer ${otherToken}`).send({ name: 'T2', slug: 't2' }).expect(201);
    otherTenantId = t2.body.id;
  });
  afterAll(async () => { await app.close(); await container.stop(); });

  it('full CRUD lifecycle', async () => {
    const created = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/projects`).set('Authorization', `Bearer ${token}`)
      .send({ name: 'Webshop bot' }).expect(201);
    expect(created.body).toMatchObject({ name: 'Webshop bot', defaultLanguage: 'nl', status: 'active' });
    const pid = created.body.id;

    const list = await request(app.getHttpServer())
      .get(`/v1/tenants/${tenantId}/projects`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(list.body).toHaveLength(1);

    await request(app.getHttpServer())
      .patch(`/v1/tenants/${tenantId}/projects/${pid}`).set('Authorization', `Bearer ${token}`)
      .send({ name: 'Support bot' }).expect(200);

    const got = await request(app.getHttpServer())
      .get(`/v1/tenants/${tenantId}/projects/${pid}`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(got.body.name).toBe('Support bot');

    await request(app.getHttpServer())
      .delete(`/v1/tenants/${tenantId}/projects/${pid}`).set('Authorization', `Bearer ${token}`).expect(200);
    const after = await request(app.getHttpServer())
      .get(`/v1/tenants/${tenantId}/projects`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(after.body).toHaveLength(0);
  });

  it('cannot read another tenant’s projects (403, not just empty)', async () => {
    await request(app.getHttpServer())
      .get(`/v1/tenants/${otherTenantId}/projects`).set('Authorization', `Bearer ${token}`).expect(403);
  });

  it('404s on a project id from another tenant schema', async () => {
    const created = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/projects`).set('Authorization', `Bearer ${token}`)
      .send({ name: 'Mine' }).expect(201);
    const otherToken = await idp.sign({ sub: 'oidc|u2', email: 'u2@other.eu' });
    await request(app.getHttpServer())
      .get(`/v1/tenants/${otherTenantId}/projects/${created.body.id}`)
      .set('Authorization', `Bearer ${otherToken}`).expect(404);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm test:int -- --testPathPattern projects.e2e` → FAIL.

- [ ] **Step 3: Implement**

Add to `api/src/auth/auth.types.ts`:
```ts
export interface TenantRef { id: string; schemaName: string }

export const Tenant = createParamDecorator((_: unknown, ctx: ExecutionContext): TenantRef => {
  return ctx.switchToHttp().getRequest<{ tenant: TenantRef }>().tenant;
});
```

`api/src/projects/dto.ts`:
```ts
import { IsOptional, IsString, Length } from 'class-validator';

export class CreateProjectDto {
  @IsString() @Length(2, 100) name!: string;
  @IsOptional() @IsString() @Length(2, 8) defaultLanguage?: string;
}

export class UpdateProjectDto {
  @IsOptional() @IsString() @Length(2, 100) name?: string;
  @IsOptional() @IsString() @Length(2, 8) defaultLanguage?: string;
}
```

`api/src/projects/projects.service.ts`:
```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { TenantDbService } from '../tenancy/tenant-db.service';

export interface Project {
  id: string; name: string; defaultLanguage: string; status: string;
  settings: Record<string, unknown>; createdAt: string; updatedAt: string;
}

function mapRow(r: Record<string, unknown>): Project {
  return {
    id: r.id as string, name: r.name as string,
    defaultLanguage: r.default_language as string, status: r.status as string,
    settings: r.settings as Record<string, unknown>,
    createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  };
}

@Injectable()
export class ProjectsService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly audit: AuditService,
  ) {}

  create(schemaName: string, input: { name: string; defaultLanguage?: string }): Promise<Project> {
    return this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(sql`
        INSERT INTO projects (name, default_language)
        VALUES (${input.name}, ${input.defaultLanguage ?? 'nl'})
        RETURNING *`);
      return mapRow(r.rows[0] as Record<string, unknown>);
    });
  }

  list(schemaName: string): Promise<Project[]> {
    return this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(sql`SELECT * FROM projects ORDER BY created_at`);
      return (r.rows as Record<string, unknown>[]).map(mapRow);
    });
  }

  async get(schemaName: string, id: string): Promise<Project> {
    const rows = await this.tenantDb.withTenant(schemaName, async (db) =>
      (await db.execute(sql`SELECT * FROM projects WHERE id = ${id}`)).rows as Record<string, unknown>[]);
    if (!rows[0]) throw new NotFoundException('Project not found');
    return mapRow(rows[0]);
  }

  async update(schemaName: string, id: string, input: { name?: string; defaultLanguage?: string }): Promise<Project> {
    const rows = await this.tenantDb.withTenant(schemaName, async (db) =>
      (await db.execute(sql`
        UPDATE projects SET
          name = COALESCE(${input.name ?? null}, name),
          default_language = COALESCE(${input.defaultLanguage ?? null}, default_language),
          updated_at = now()
        WHERE id = ${id} RETURNING *`)).rows as Record<string, unknown>[]);
    if (!rows[0]) throw new NotFoundException('Project not found');
    return mapRow(rows[0]);
  }

  async remove(tenant: { id: string; schemaName: string }, id: string, actorUserId: string): Promise<void> {
    const rows = await this.tenantDb.withTenant(tenant.schemaName, async (db) =>
      (await db.execute(sql`DELETE FROM projects WHERE id = ${id} RETURNING id`)).rows);
    if (!rows[0]) throw new NotFoundException('Project not found');
    await this.audit.record({ tenantId: tenant.id, actorUserId, action: 'project.deleted', resource: `project:${id}` });
  }
}
```

Note: passing a non-UUID as `${id}` makes Postgres throw a cast error → add `ParseUUIDPipe` on all `:projectId` params in the controller so bad ids are 400s, and cross-schema ids simply don't match → 404.

`api/src/projects/projects.controller.ts`:
```ts
import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { AuthUser, CurrentUser, Tenant, TenantRef } from '../auth/auth.types';
import { RequireRole } from '../auth/roles.decorator';
import { CreateProjectDto, UpdateProjectDto } from './dto';
import { ProjectsService } from './projects.service';

@Controller('tenants/:tenantId/projects')
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}

  @Post()
  @RequireRole('editor')
  create(@Tenant() tenant: TenantRef, @Body() dto: CreateProjectDto) {
    return this.projectsService.create(tenant.schemaName, dto);
  }

  @Get()
  list(@Tenant() tenant: TenantRef) {
    return this.projectsService.list(tenant.schemaName);
  }

  @Get(':projectId')
  get(@Tenant() tenant: TenantRef, @Param('projectId', ParseUUIDPipe) id: string) {
    return this.projectsService.get(tenant.schemaName, id);
  }

  @Patch(':projectId')
  @RequireRole('editor')
  update(@Tenant() tenant: TenantRef, @Param('projectId', ParseUUIDPipe) id: string, @Body() dto: UpdateProjectDto) {
    return this.projectsService.update(tenant.schemaName, id, dto);
  }

  @Delete(':projectId')
  @RequireRole('admin')
  async remove(@Tenant() tenant: TenantRef, @Param('projectId', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    await this.projectsService.remove(tenant, id, user.id);
    return { ok: true };
  }
}
```

`api/src/projects/projects.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { TenancyModule } from '../tenancy/tenancy.module';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

@Module({
  imports: [TenancyModule],
  controllers: [ProjectsController],
  providers: [ProjectsService],
})
export class ProjectsModule {}
```

Add `ProjectsModule` to `AppModule`.

- [ ] **Step 4: Run tests** — `pnpm test:int -- --testPathPattern projects.e2e` → 3 PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(api): project crud inside tenant schemas"`

---

### Task 11: API keys (issue, revoke, verify)

**Files:**
- Create: `api/src/apikeys/apikeys.module.ts`, `api/src/apikeys/apikeys.service.ts`, `api/src/apikeys/apikeys.controller.ts`, `api/src/apikeys/dto.ts`, `api/src/apikeys/apikeys.service.spec.ts`, `api/test/apikeys.e2e.integration.spec.ts`

**Interfaces:**
- Consumes: `DB`, `schema.apiKeys`, `AuditService`, guards from Tasks 6–7.
- Produces: `ApiKeysService.issue(tenantId, input: { name: string; kind: 'secret'|'public_widget'; scopes?: string[]; allowedOrigins?: string[] }): Promise<{ id: string; key: string; keyPrefix: string }>` (full `key` returned exactly once); `ApiKeysService.verify(key: string): Promise<{ id: string; tenantId: string; kind: string; scopes: string[]; allowedOrigins: string[] } | null>` (null if unknown/revoked; updates `last_used_at`); `ApiKeysService.revoke(tenantId, keyId): Promise<void>`. Endpoints: `POST /v1/tenants/:tenantId/api-keys` (admin, audited `api_key.created`), `GET` list (admin; without hashes), `DELETE /:keyId` (admin, audited `api_key.revoked`). Key format helpers: `generateKey(): { key: string; prefix: string; hash: string }` where `key = 'bsk_' + base64url(32 random bytes)`, `prefix = key.slice(0, 12)`, `hash = sha256hex(key)`.

- [ ] **Step 1: Write failing unit test `api/src/apikeys/apikeys.service.spec.ts`**

```ts
import { generateKey, hashKey } from './apikeys.service';

describe('api key generation', () => {
  it('generates bsk_-prefixed keys with 12-char prefix and sha256 hash', () => {
    const { key, prefix, hash } = generateKey();
    expect(key).toMatch(/^bsk_[A-Za-z0-9_-]{43}$/);
    expect(prefix).toBe(key.slice(0, 12));
    expect(hash).toBe(hashKey(key));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('generates unique keys', () => {
    expect(generateKey().key).not.toBe(generateKey().key);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm test -- --testPathPattern apikeys.service` → FAIL.

- [ ] **Step 3: Implement**

`api/src/apikeys/apikeys.service.ts`:
```ts
import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { Db, DB } from '../db/db.module';
import { apiKeys } from '../db/schema';

export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function generateKey(): { key: string; prefix: string; hash: string } {
  const key = `bsk_${randomBytes(32).toString('base64url')}`;
  return { key, prefix: key.slice(0, 12), hash: hashKey(key) };
}

export interface VerifiedKey {
  id: string; tenantId: string; kind: 'secret' | 'public_widget';
  scopes: string[]; allowedOrigins: string[];
}

@Injectable()
export class ApiKeysService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async issue(
    tenantId: string,
    input: { name: string; kind: 'secret' | 'public_widget'; scopes?: string[]; allowedOrigins?: string[] },
    actorUserId: string,
  ): Promise<{ id: string; key: string; keyPrefix: string }> {
    const { key, prefix, hash } = generateKey();
    const [row] = await this.db.insert(apiKeys).values({
      tenantId, name: input.name, keyPrefix: prefix, keyHash: hash,
      kind: input.kind, scopes: input.scopes ?? [], allowedOrigins: input.allowedOrigins ?? [],
    }).returning();
    await this.audit.record({ tenantId, actorUserId, action: 'api_key.created', resource: `api_key:${row.id}`, metadata: { kind: input.kind } });
    return { id: row.id, key, keyPrefix: prefix };
  }

  async verify(key: string): Promise<VerifiedKey | null> {
    const [row] = await this.db.select().from(apiKeys)
      .where(and(eq(apiKeys.keyHash, hashKey(key)), isNull(apiKeys.revokedAt)));
    if (!row) return null;
    await this.db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.id));
    return { id: row.id, tenantId: row.tenantId, kind: row.kind, scopes: row.scopes, allowedOrigins: row.allowedOrigins };
  }

  async list(tenantId: string): Promise<Array<{ id: string; name: string; keyPrefix: string; kind: string; createdAt: Date; revokedAt: Date | null }>> {
    return this.db.select({
      id: apiKeys.id, name: apiKeys.name, keyPrefix: apiKeys.keyPrefix,
      kind: apiKeys.kind, createdAt: apiKeys.createdAt, revokedAt: apiKeys.revokedAt,
    }).from(apiKeys).where(eq(apiKeys.tenantId, tenantId));
  }

  async revoke(tenantId: string, keyId: string, actorUserId: string): Promise<void> {
    const result = await this.db.update(apiKeys).set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.id, keyId), eq(apiKeys.tenantId, tenantId), isNull(apiKeys.revokedAt)))
      .returning({ id: apiKeys.id });
    if (result.length === 0) throw new NotFoundException('API key not found');
    await this.audit.record({ tenantId, actorUserId, action: 'api_key.revoked', resource: `api_key:${keyId}` });
  }
}
```

`api/src/apikeys/dto.ts`:
```ts
import { IsArray, IsIn, IsOptional, IsString, Length } from 'class-validator';

export class CreateApiKeyDto {
  @IsString() @Length(2, 100) name!: string;
  @IsIn(['secret', 'public_widget']) kind!: 'secret' | 'public_widget';
  @IsOptional() @IsArray() @IsString({ each: true }) scopes?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) allowedOrigins?: string[];
}
```

`api/src/apikeys/apikeys.controller.ts`:
```ts
import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { AuthUser, CurrentUser, Tenant, TenantRef } from '../auth/auth.types';
import { RequireRole } from '../auth/roles.decorator';
import { ApiKeysService } from './apikeys.service';
import { CreateApiKeyDto } from './dto';

@Controller('tenants/:tenantId/api-keys')
@RequireRole('admin')
export class ApiKeysController {
  constructor(private readonly apiKeysService: ApiKeysService) {}

  @Post()
  issue(@Tenant() tenant: TenantRef, @Body() dto: CreateApiKeyDto, @CurrentUser() user: AuthUser) {
    return this.apiKeysService.issue(tenant.id, dto, user.id);
  }

  @Get()
  list(@Tenant() tenant: TenantRef) {
    return this.apiKeysService.list(tenant.id);
  }

  @Delete(':keyId')
  async revoke(@Tenant() tenant: TenantRef, @Param('keyId', ParseUUIDPipe) keyId: string, @CurrentUser() user: AuthUser) {
    await this.apiKeysService.revoke(tenant.id, keyId, user.id);
    return { ok: true };
  }
}
```

`api/src/apikeys/apikeys.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { ApiKeysController } from './apikeys.controller';
import { ApiKeysService } from './apikeys.service';

@Module({
  controllers: [ApiKeysController],
  providers: [ApiKeysService],
  exports: [ApiKeysService],
})
export class ApiKeysModule {}
```

Add `ApiKeysModule` to `AppModule`.

- [ ] **Step 4: Write e2e test `api/test/apikeys.e2e.integration.spec.ts`**

```ts
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ApiKeysService } from '../src/apikeys/apikeys.service';
import { startPg } from './helpers/pg';
import { buildTestApp } from './helpers/app';

describe('api keys e2e', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let token: string;
  let tenantId: string;

  beforeAll(async () => {
    ({ container, pool } = await startPg());
    const built = await buildTestApp(pool);
    app = built.app;
    token = await built.idp.sign({ sub: 'oidc|u1', email: 'u1@acme.eu' });
    const t = await request(app.getHttpServer()).post('/v1/tenants')
      .set('Authorization', `Bearer ${token}`).send({ name: 'T', slug: 't' }).expect(201);
    tenantId = t.body.id;
  });
  afterAll(async () => { await app.close(); await container.stop(); });

  it('issues a key (secret shown once), verifies it, then revoke kills it', async () => {
    const res = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/api-keys`).set('Authorization', `Bearer ${token}`)
      .send({ name: 'ci key', kind: 'secret' }).expect(201);
    expect(res.body.key).toMatch(/^bsk_/);

    const svc = app.get(ApiKeysService);
    const verified = await svc.verify(res.body.key);
    expect(verified).toMatchObject({ tenantId, kind: 'secret' });

    const list = await request(app.getHttpServer())
      .get(`/v1/tenants/${tenantId}/api-keys`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(list.body[0]).not.toHaveProperty('keyHash');
    expect(list.body[0]).not.toHaveProperty('key');

    await request(app.getHttpServer())
      .delete(`/v1/tenants/${tenantId}/api-keys/${res.body.id}`)
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(await svc.verify(res.body.key)).toBeNull();
  });
});
```

- [ ] **Step 5: Run all tests** — `pnpm test && pnpm test:int` → all green.
- [ ] **Step 6: Commit** — `git commit -am "feat(api): tenant api keys with hashed storage, revocation, audit"`

---

### Task 12: OpenAPI docs, request logging, error envelope, prod compose + Caddy

**Files:**
- Modify: `api/src/main.ts`, `/Users/lars/bonsai/docker-compose.yml`
- Create: `api/src/common/http-exception.filter.ts`, `api/src/common/request-id.middleware.ts`, `api/src/common/http-exception.filter.spec.ts`, `api/Dockerfile`, `/Users/lars/bonsai/Caddyfile`, `/Users/lars/bonsai/.env.example`, `/Users/lars/bonsai/README.md`

**Interfaces:**
- Consumes: everything prior.
- Produces: Swagger UI at `/docs` (public); every response carries `x-request-id`; all errors return envelope `{ error: { status: number; message: string; requestId: string } }`; `docker compose up` serves the API behind Caddy TLS on `chat.bonsaimedia.nl`.

- [ ] **Step 1: Write failing unit test `api/src/common/http-exception.filter.spec.ts`**

```ts
import { ArgumentsHost, NotFoundException } from '@nestjs/common';
import { HttpExceptionFilter } from './http-exception.filter';

describe('HttpExceptionFilter', () => {
  it('wraps errors in the envelope with requestId', () => {
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status }),
        getRequest: () => ({ requestId: 'req-1' }),
      }),
    } as unknown as ArgumentsHost;

    new HttpExceptionFilter().catch(new NotFoundException('Project not found'), host);
    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({ error: { status: 404, message: 'Project not found', requestId: 'req-1' } });
  });

  it('masks non-http errors as 500 without leaking internals', () => {
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status }),
        getRequest: () => ({ requestId: 'req-2' }),
      }),
    } as unknown as ArgumentsHost;

    new HttpExceptionFilter().catch(new Error('secret db string'), host);
    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ error: { status: 500, message: 'Internal server error', requestId: 'req-2' } });
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm test -- --testPathPattern http-exception` → FAIL.

- [ ] **Step 3: Implement**

`api/src/common/http-exception.filter.ts`:
```ts
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';

interface ResLike { status(code: number): { json(body: unknown): void } }

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Http');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<ResLike>();
    const req = ctx.getRequest<{ requestId?: string }>();
    const requestId = req.requestId ?? 'unknown';

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const raw = exception.getResponse();
      const message = typeof raw === 'string' ? raw : ((raw as { message?: string | string[] }).message ?? exception.message);
      res.status(status).json({ error: { status, message: Array.isArray(message) ? message.join('; ') : message, requestId } });
      return;
    }
    this.logger.error(`Unhandled error [${requestId}]`, exception instanceof Error ? exception.stack : String(exception));
    res.status(500).json({ error: { status: 500, message: 'Internal server error', requestId } });
  }
}
```

`api/src/common/request-id.middleware.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';

export function requestIdMiddleware(req: Request & { requestId?: string }, res: Response, next: NextFunction): void {
  const id = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();
  req.requestId = id;
  res.setHeader('x-request-id', id);
  next();
}
```

`api/src/main.ts`:
```ts
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { APP_CONFIG, AppConfig } from './config/config';
import { HttpExceptionFilter } from './common/http-exception.filter';
import { requestIdMiddleware } from './common/request-id.middleware';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const cfg = app.get<AppConfig>(APP_CONFIG);
  app.use(requestIdMiddleware);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new HttpExceptionFilter());
  app.setGlobalPrefix('v1', { exclude: ['health', 'docs'] });
  app.enableShutdownHooks();

  const doc = SwaggerModule.createDocument(app, new DocumentBuilder()
    .setTitle('Bonsai API').setVersion('0.1')
    .addBearerAuth().build());
  SwaggerModule.setup('docs', app, doc);

  await app.listen(cfg.port);
}
void bootstrap();
```
(`pnpm add @nestjs/swagger`.) Also add `app.useGlobalFilters(new HttpExceptionFilter())` and `app.use(requestIdMiddleware)` to `buildTestApp` in `api/test/helpers/app.ts` so tests exercise the same stack.

`api/Dockerfile`:
```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && pnpm prune --prod

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
EXPOSE 3000
CMD ["node", "dist/main.js"]
```

Append to `/Users/lars/bonsai/docker-compose.yml`:
```yaml
  api:
    build: ./api
    environment:
      DATABASE_URL: postgres://bonsai:bonsai_dev@postgres:5432/bonsai
      OIDC_ISSUER: ${OIDC_ISSUER}
      OIDC_AUDIENCE: ${OIDC_AUDIENCE}
      OIDC_JWKS_URL: ${OIDC_JWKS_URL}
    depends_on: [postgres, redis]
  caddy:
    image: caddy:2-alpine
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
    depends_on: [api]
```
(add `caddy_data:` under `volumes:`)

`/Users/lars/bonsai/Caddyfile`:
```
chat.bonsaimedia.nl {
    reverse_proxy api:3000
}
```

`/Users/lars/bonsai/.env.example`:
```
DATABASE_URL=postgres://bonsai:bonsai_dev@localhost:5432/bonsai
OIDC_ISSUER=https://your-idp.example.eu
OIDC_AUDIENCE=bonsai-api
OIDC_JWKS_URL=https://your-idp.example.eu/oauth/v2/keys
```

`/Users/lars/bonsai/README.md`: title, one-paragraph description, `docker compose up -d postgres redis`, `cd api && pnpm install && pnpm test && pnpm test:int`, `pnpm start:dev`, link to `/docs`, pointer to the spec + plan files.

- [ ] **Step 4: Run everything** — `pnpm test && pnpm test:int` → all green; `pnpm build` → compiles.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(api): openapi docs, error envelope, request ids, prod compose with caddy"`

---

## Final verification (whole phase)

- [ ] `cd api && pnpm test && pnpm test:int` — all suites green.
- [ ] `pnpm build` — clean compile.
- [ ] Confirm the isolation test (`tenant-isolation.integration.spec.ts`) covers: cross-schema invisibility, rollback, schema-name injection rejection.
- [ ] `git log --oneline` shows one commit per task.
