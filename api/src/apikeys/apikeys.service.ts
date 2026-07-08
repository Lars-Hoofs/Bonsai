import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { DB } from '../db/db.module';
import type { Db } from '../db/db.module';
import { apiKeys, tenants } from '../db/schema';

export interface ResolvedWidgetKey {
  tenantId: string;
  projectId: string;
  schemaName: string;
}

export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function generateKey(): { key: string; prefix: string; hash: string } {
  const key = `bsk_${randomBytes(32).toString('base64url')}`;
  return { key, prefix: key.slice(0, 12), hash: hashKey(key) };
}

export type ApiKeyKind = 'secret' | 'public_widget';

export interface VerifiedKey {
  id: string;
  tenantId: string;
  kind: ApiKeyKind;
  scopes: string[];
  allowedOrigins: string[];
}

export interface ApiKeyListItem {
  id: string;
  name: string;
  keyPrefix: string;
  kind: ApiKeyKind;
  createdAt: Date;
  revokedAt: Date | null;
}

@Injectable()
export class ApiKeysService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async issue(
    tenantId: string,
    input: {
      name: string;
      kind: ApiKeyKind;
      projectId?: string;
      scopes?: string[];
      allowedOrigins?: string[];
    },
    actorUserId: string,
  ): Promise<{ id: string; key: string; keyPrefix: string }> {
    const { key, prefix, hash } = generateKey();
    const [row] = await this.db
      .insert(apiKeys)
      .values({
        tenantId,
        projectId: input.projectId,
        name: input.name,
        keyPrefix: prefix,
        keyHash: hash,
        kind: input.kind,
        scopes: input.scopes ?? [],
        allowedOrigins: input.allowedOrigins ?? [],
      })
      .returning();
    await this.audit.record({
      tenantId,
      actorUserId,
      action: 'api_key.created',
      resource: `api_key:${row.id}`,
      metadata: { kind: input.kind },
    });
    return { id: row.id, key, keyPrefix: prefix };
  }

  /**
   * Resolves a public_widget key for anonymous widget delivery: the key must be
   * a non-revoked public_widget key bound to a project, and — if the key
   * declares allowed origins — the request Origin must match one of them.
   * Returns the tenant schema + project so the caller can serve that project's
   * published widget theme.
   */
  async resolveWidgetKey(
    key: string,
    origin: string | undefined,
  ): Promise<ResolvedWidgetKey | null> {
    const [row] = await this.db
      .select()
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.keyHash, hashKey(key)),
          isNull(apiKeys.revokedAt),
          eq(apiKeys.kind, 'public_widget'),
        ),
      );
    if (!row || !row.projectId) return null;
    if (row.allowedOrigins.length > 0) {
      if (!origin || !row.allowedOrigins.includes(origin)) return null;
    }
    const [tenant] = await this.db
      .select({ schemaName: tenants.schemaName })
      .from(tenants)
      .where(eq(tenants.id, row.tenantId));
    if (!tenant) return null;
    return {
      tenantId: row.tenantId,
      projectId: row.projectId,
      schemaName: tenant.schemaName,
    };
  }

  async verify(key: string): Promise<VerifiedKey | null> {
    const [row] = await this.db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.keyHash, hashKey(key)), isNull(apiKeys.revokedAt)));
    if (!row) return null;
    await this.db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, row.id));
    return {
      id: row.id,
      tenantId: row.tenantId,
      kind: row.kind,
      scopes: row.scopes,
      allowedOrigins: row.allowedOrigins,
    };
  }

  async list(tenantId: string): Promise<ApiKeyListItem[]> {
    return this.db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        keyPrefix: apiKeys.keyPrefix,
        kind: apiKeys.kind,
        createdAt: apiKeys.createdAt,
        revokedAt: apiKeys.revokedAt,
      })
      .from(apiKeys)
      .where(eq(apiKeys.tenantId, tenantId));
  }

  async revoke(
    tenantId: string,
    keyId: string,
    actorUserId: string,
  ): Promise<void> {
    const result = await this.db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(apiKeys.id, keyId),
          eq(apiKeys.tenantId, tenantId),
          isNull(apiKeys.revokedAt),
        ),
      )
      .returning({ id: apiKeys.id });
    if (result.length === 0) throw new NotFoundException('API key not found');
    await this.audit.record({
      tenantId,
      actorUserId,
      action: 'api_key.revoked',
      resource: `api_key:${keyId}`,
    });
  }
}
