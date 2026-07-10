import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { APP_CONFIG } from '../config/config';
import type { AppConfig } from '../config/config';
import { TenantDbService } from '../tenancy/tenant-db.service';
import { detectProfanity, readProfanityConfig } from './profanity-filter';
import type { ProfanityAction } from './profanity-filter';

export interface ModerationEvent {
  id: string;
  projectId: string;
  conversationId: string | null;
  action: ProfanityAction;
  matchedTerms: string[];
  content: string;
  createdAt: string;
}

/**
 * Outcome of screening a single visitor message. `action` is only present
 * when the message matched AND the project has the filter enabled:
 * - 'flag'  -> the message is allowed through to the answer pipeline as
 *              normal, but the hit is recorded for moderators.
 * - 'warn'  -> the message is NOT answered; the visitor gets a warning and
 *              the hit is recorded.
 * - 'block' -> same as warn (no answer), with a stronger "blocked" reply.
 * When `action` is undefined the caller proceeds exactly as before #31.
 */
export interface ScreenResult {
  action?: ProfanityAction;
  matchedTerms: string[];
}

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

function mapRow(r: Record<string, unknown>): ModerationEvent {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    conversationId: (r.conversation_id as string | null) ?? null,
    action: r.action as ProfanityAction,
    matchedTerms: (r.matched_terms as string[]) ?? [],
    content: r.content as string,
    createdAt: String(r.created_at),
  };
}

/**
 * Self-hosted profanity/abuse moderation (#31). Screens inbound visitor
 * messages against the per-project heuristic filter, records triggered
 * events, and exposes them to back-office roles. Config-gated per project via
 * `projects.settings.profanityFilter` and by the global
 * `profanityFilterEnabled` kill-switch.
 */
@Injectable()
export class ModerationService {
  constructor(
    private readonly tenantDb: TenantDbService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  /**
   * Screens a visitor message. When the global flag is off, or the project
   * hasn't enabled the filter, or nothing matches, returns
   * `{ action: undefined }` and the caller behaves exactly as pre-#31. When
   * it matches an enabled filter, records a `moderation_events` row and
   * returns the configured `action` so the caller can apply the policy
   * before the answer pipeline runs.
   */
  async screenVisitorMessage(
    schemaName: string,
    projectId: string,
    conversationId: string,
    text: string,
  ): Promise<ScreenResult> {
    if (!this.cfg.profanityFilterEnabled) return { matchedTerms: [] };

    const settings = await this.loadProjectSettings(schemaName, projectId);
    const config = readProfanityConfig(settings);
    if (!config.enabled) return { matchedTerms: [] };

    const { matched, terms } = detectProfanity(text, {
      extraTerms: config.extraTerms,
      allowTerms: config.allowTerms,
    });
    if (!matched) return { matchedTerms: [] };

    await this.record(schemaName, projectId, conversationId, config.action, {
      matchedTerms: terms,
      content: text,
    });
    return { action: config.action, matchedTerms: terms };
  }

  private async record(
    schemaName: string,
    projectId: string,
    conversationId: string,
    action: ProfanityAction,
    input: { matchedTerms: string[]; content: string },
  ): Promise<void> {
    await this.tenantDb.withTenant(schemaName, (db) =>
      db.execute(
        sql`INSERT INTO moderation_events
              (project_id, conversation_id, action, matched_terms, content)
            VALUES (${projectId}, ${conversationId}, ${action},
              ${sql.param(input.matchedTerms)}::text[], ${input.content})`,
      ),
    );
  }

  async list(
    schemaName: string,
    projectId: string,
    pagination: { limit?: number; offset?: number },
  ): Promise<ModerationEvent[]> {
    const limit = Math.min(
      pagination.limit ?? DEFAULT_LIST_LIMIT,
      MAX_LIST_LIMIT,
    );
    const offset = pagination.offset ?? 0;
    return this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`SELECT * FROM moderation_events
            WHERE project_id = ${projectId}
            ORDER BY created_at DESC
            LIMIT ${limit} OFFSET ${offset}`,
      );
      return r.rows.map(mapRow);
    });
  }

  private async loadProjectSettings(
    schemaName: string,
    projectId: string,
  ): Promise<Record<string, unknown>> {
    return this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`SELECT settings FROM projects WHERE id = ${projectId}`,
      );
      const row = r.rows[0] as
        { settings?: Record<string, unknown> } | undefined;
      return row?.settings ?? {};
    });
  }
}
