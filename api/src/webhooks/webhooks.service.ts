import { createHmac, randomBytes } from 'node:crypto';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { TenantDbService } from '../tenancy/tenant-db.service';
import { safeFetch } from '../common/safe-fetch';

export function signPayload(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

export interface WebhookListItem {
  id: string;
  url: string;
  events: string[];
  createdAt: string;
}

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(private readonly tenantDb: TenantDbService) {}

  async register(
    schemaName: string,
    projectId: string,
    input: { url: string; events: string[] },
  ): Promise<{ id: string; secret: string }> {
    const secret = `whsec_${randomBytes(24).toString('base64url')}`;
    const id = await this.tenantDb.withTenant(schemaName, async (db) => {
      // Bind the JS string array as a single parameter via `sql.param` (cast
      // to text[]) rather than hand-building a Postgres array-literal string.
      // A bare `${input.events}` interpolation would instead splice the
      // array as N separate comma-joined placeholders (drizzle's `IN (...)`
      // convenience behavior) — wrong shape for a single text[] column and
      // NOT what we want here. `sql.param` forces it to bind as one value,
      // which node-postgres then serializes as a proper array literal
      // itself, with no manual escaping needed or wanted.
      const r = await db.execute(
        sql`INSERT INTO webhooks (project_id, url, events, secret)
            VALUES (${projectId}, ${input.url}, ${sql.param(input.events)}::text[], ${secret})
            RETURNING id`,
      );
      return (r.rows[0] as { id: string }).id;
    });
    return { id, secret };
  }

  async list(
    schemaName: string,
    projectId: string,
  ): Promise<WebhookListItem[]> {
    return this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`SELECT id, url, events, created_at FROM webhooks WHERE project_id=${projectId} ORDER BY created_at`,
      );
      return r.rows.map((row) => ({
        id: row.id as string,
        url: row.url as string,
        events: row.events as string[],
        createdAt: String(row.created_at),
      }));
    });
  }

  async remove(
    schemaName: string,
    projectId: string,
    id: string,
  ): Promise<void> {
    const ok = await this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`DELETE FROM webhooks WHERE id=${id} AND project_id=${projectId} RETURNING id`,
      );
      return r.rows.length > 0;
    });
    if (!ok) throw new NotFoundException('Webhook not found');
  }

  /**
   * Best-effort delivery to every webhook subscribed to `event`. Signs the body
   * with the per-webhook secret (HMAC-SHA256, header x-bonsai-signature).
   * Failures are logged, never thrown — a dead endpoint must not break the app.
   */
  async dispatch(
    schemaName: string,
    projectId: string,
    event: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const hooks = await this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`SELECT url, secret FROM webhooks
            WHERE project_id=${projectId} AND ${event} = ANY(events)`,
      );
      return r.rows as { url: string; secret: string }[];
    });
    if (hooks.length === 0) return;

    const body = JSON.stringify({
      event,
      data,
      timestamp: new Date().toISOString(),
    });
    await Promise.all(
      hooks.map(async (h) => {
        try {
          await safeFetch(h.url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-bonsai-event': event,
              'x-bonsai-signature': signPayload(h.secret, body),
            },
            body,
          });
        } catch (err) {
          this.logger.warn(
            `Webhook delivery to ${h.url} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }),
    );
  }
}
