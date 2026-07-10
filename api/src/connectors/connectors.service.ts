import { Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { EncryptionService } from '../common/encryption.service';
import { TenantDbService } from '../tenancy/tenant-db.service';
import type { ConnectorAuthInput } from './dto';

/** Public-facing connector shape: credentials are NEVER included. */
export interface Connector {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  baseUrl: string;
  method: string;
  hasAuth: boolean;
  requestSchema: Record<string, unknown>;
  responseTemplate: string | null;
  usageHint: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * INTERNAL shape used by the (future, part-2) tool-calling pipeline only:
 * includes the decrypted `auth` object. Never returned by any controller.
 */
export interface ConnectorWithAuth extends Connector {
  auth: Record<string, unknown> | null;
}

export interface ConnectorInput {
  name: string;
  description?: string;
  baseUrl: string;
  method: string;
  requestSchema?: Record<string, unknown>;
  responseTemplate?: string;
  usageHint?: string;
  auth?: ConnectorAuthInput;
}

function toIso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

function mapRow(r: Record<string, unknown>): Connector {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    name: r.name as string,
    description: (r.description as string | null) ?? null,
    baseUrl: r.base_url as string,
    method: r.method as string,
    hasAuth: r.auth_encrypted != null,
    requestSchema: (r.request_schema as Record<string, unknown>) ?? {},
    responseTemplate: (r.response_template as string | null) ?? null,
    usageHint: (r.usage_hint as string | null) ?? null,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
}

@Injectable()
export class ConnectorsService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly audit: AuditService,
    private readonly encryption: EncryptionService,
  ) {}

  /**
   * Validates a connector base_url structurally: http/https scheme + a host
   * present (same shape of check as the start of
   * `safe-fetch.ts#assertPublicHttpUrl`). We deliberately do NOT call
   * `assertPublicHttpUrl` itself here, and do NOT perform DNS resolution /
   * SSRF blocking at connector-configuration time — the target host can
   * legitimately change (DNS, infra) between when a connector is saved and
   * when it's actually invoked, so that enforcement belongs at call time, in
   * the (separate, later) tool-calling pipeline, via `safeFetch`.
   */
  private validateBaseUrl(rawUrl: string): void {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new Error('Invalid base_url');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Invalid base_url');
    }
    if (!url.hostname) {
      throw new Error('Invalid base_url');
    }
  }

  private encryptAuth(auth: ConnectorAuthInput | undefined): string | null {
    if (auth === undefined) return null;
    return this.encryption.encrypt(JSON.stringify(auth));
  }

  async create(
    schemaName: string,
    projectId: string,
    input: ConnectorInput,
    actorUserId: string,
    tenantId: string,
  ): Promise<Connector> {
    this.validateBaseUrl(input.baseUrl);
    const authEncrypted = this.encryptAuth(input.auth);
    const row = await this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(sql`
        INSERT INTO api_connectors
          (project_id, name, description, base_url, method, auth_encrypted, request_schema, response_template, usage_hint)
        VALUES
          (${projectId}, ${input.name}, ${input.description ?? null}, ${input.baseUrl}, ${input.method},
           ${authEncrypted}, ${JSON.stringify(input.requestSchema ?? {})}::jsonb,
           ${input.responseTemplate ?? null}, ${input.usageHint ?? null})
        RETURNING *`);
      return r.rows[0];
    });
    const connector = mapRow(row);
    await this.audit.record({
      tenantId,
      actorUserId,
      action: 'connector.created',
      resource: `connector:${connector.id}`,
    });
    return connector;
  }

  async list(schemaName: string, projectId: string): Promise<Connector[]> {
    return this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`SELECT * FROM api_connectors WHERE project_id = ${projectId} ORDER BY created_at`,
      );
      return r.rows.map(mapRow);
    });
  }

  async get(
    schemaName: string,
    projectId: string,
    id: string,
  ): Promise<Connector> {
    const rows = await this.tenantDb.withTenant(
      schemaName,
      async (db) =>
        (
          await db.execute(
            sql`SELECT * FROM api_connectors WHERE id = ${id} AND project_id = ${projectId}`,
          )
        ).rows,
    );
    if (!rows[0]) throw new NotFoundException('Connector not found');
    return mapRow(rows[0]);
  }

  async update(
    schemaName: string,
    projectId: string,
    id: string,
    input: Partial<ConnectorInput>,
  ): Promise<Connector> {
    if (input.baseUrl !== undefined) {
      this.validateBaseUrl(input.baseUrl);
    }
    const authEncrypted =
      input.auth !== undefined ? this.encryptAuth(input.auth) : undefined;
    const rows = await this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(sql`
        UPDATE api_connectors SET
          name = COALESCE(${input.name ?? null}, name),
          description = COALESCE(${input.description ?? null}, description),
          base_url = COALESCE(${input.baseUrl ?? null}, base_url),
          method = COALESCE(${input.method ?? null}, method),
          auth_encrypted = COALESCE(${authEncrypted ?? null}, auth_encrypted),
          request_schema = COALESCE(${input.requestSchema ? JSON.stringify(input.requestSchema) : null}::jsonb, request_schema),
          response_template = COALESCE(${input.responseTemplate ?? null}, response_template),
          usage_hint = COALESCE(${input.usageHint ?? null}, usage_hint),
          updated_at = now()
        WHERE id = ${id} AND project_id = ${projectId}
        RETURNING *`);
      return r.rows;
    });
    if (!rows[0]) throw new NotFoundException('Connector not found');
    return mapRow(rows[0]);
  }

  async remove(
    tenant: { id: string; schemaName: string },
    projectId: string,
    id: string,
    actorUserId: string,
  ): Promise<void> {
    await this.tenantDb.withTenant(tenant.schemaName, async (db) => {
      const rows = (
        await db.execute(
          sql`DELETE FROM api_connectors WHERE id = ${id} AND project_id = ${projectId} RETURNING id`,
        )
      ).rows;
      if (!rows[0]) throw new NotFoundException('Connector not found');
      await this.audit.record(
        {
          tenantId: tenant.id,
          actorUserId,
          action: 'connector.deleted',
          resource: `connector:${id}`,
        },
        db,
      );
    });
  }

  /**
   * INTERNAL — used by the (separate, later) tool-calling pipeline only.
   * Decrypts the stored credentials. Not exposed via any controller.
   */
  async getWithAuth(
    schemaName: string,
    connectorId: string,
  ): Promise<ConnectorWithAuth> {
    const row = await this.tenantDb.withTenant(
      schemaName,
      async (db) =>
        (
          await db.execute(
            sql`SELECT * FROM api_connectors WHERE id = ${connectorId}`,
          )
        ).rows[0],
    );
    if (!row) throw new NotFoundException('Connector not found');
    const connector = mapRow(row);
    const authEncrypted = row.auth_encrypted as string | null;
    const auth = authEncrypted
      ? (JSON.parse(this.encryption.decrypt(authEncrypted)) as Record<
          string,
          unknown
        >)
      : null;
    return { ...connector, auth };
  }
}
