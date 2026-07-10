import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/db.module';
import { ROLE_RANK } from '../auth/roles.decorator';
import type { Role } from '../db/schema';

export type PresenceStatus = 'available' | 'away';

/** Minimum role (inclusive) a member must hold to be eligible for auto-assignment. */
const ASSIGNABLE_ROLE: Role = 'agent';
/** How long a self-reported "available" status is trusted without a refresh. */
const FRESHNESS_WINDOW_MINUTES = 5;

/**
 * Control-plane service (no `withTenant`): agent presence is keyed by
 * tenant_id + user_id in `public.agent_presence`, not stored per-tenant
 * schema, so it's read/written via the global DB like `memberships`/`users`.
 */
@Injectable()
export class PresenceService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Upserts the caller's presence for a tenant. Always refreshes
   * `last_seen_at` to now(), including on repeat calls with the same
   * status, so a client can "heartbeat" by re-sending the same status.
   */
  async setPresence(
    tenantId: string,
    userId: string,
    status: PresenceStatus,
  ): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO agent_presence (tenant_id, user_id, status, last_seen_at)
      VALUES (${tenantId}, ${userId}, ${status}, now())
      ON CONFLICT (tenant_id, user_id)
      DO UPDATE SET status = ${status}, last_seen_at = now()
    `);
  }

  /**
   * User ids that are: self-reported 'available', fresh (within the
   * freshness window), and hold at least the `agent` role in this tenant.
   * Used to pick an auto-assignment candidate on escalation.
   */
  async listAvailable(tenantId: string): Promise<string[]> {
    const assignableRoles = (Object.keys(ROLE_RANK) as Role[]).filter(
      (role) => ROLE_RANK[role] >= ROLE_RANK[ASSIGNABLE_ROLE],
    );
    const roleList = sql.join(
      assignableRoles.map((role) => sql`${role}`),
      sql`, `,
    );
    const r = await this.db.execute(sql`
      SELECT ap.user_id
      FROM agent_presence ap
      JOIN memberships m
        ON m.tenant_id = ap.tenant_id AND m.user_id = ap.user_id
      WHERE ap.tenant_id = ${tenantId}
        AND ap.status = 'available'
        AND ap.last_seen_at >= now() - make_interval(mins => ${FRESHNESS_WINDOW_MINUTES})
        AND m.role IN (${roleList})
    `);
    return r.rows.map((row) => (row as { user_id: string }).user_id);
  }
}
