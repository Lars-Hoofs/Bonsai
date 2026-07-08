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
