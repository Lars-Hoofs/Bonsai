import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { sql } from 'drizzle-orm';
import { TenantDbService } from '../tenancy/tenant-db.service';
import { AnswerService } from '../rag/answer.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { UsageService } from '../usage/usage.service';
import { MetricsService } from '../metrics/metrics.service';
import { AuditService } from '../audit/audit.service';
import { PresenceService } from '../presence/presence.service';
import { MembershipsService } from '../auth/memberships.service';
import { ROLE_RANK } from '../auth/roles.decorator';
import { APP_CONFIG } from '../config/config';
import type { AppConfig } from '../config/config';
import { CHAT_MESSAGE_EVENT } from './chat.gateway';
import { isOpen } from './business-hours';
import type { BusinessHours } from './business-hours';
import { isFrustrated } from './frustration';

const DEFAULT_HANDOVER_MESSAGE = 'Gesprek doorgezet naar een medewerker.';
const DEFAULT_AFTER_HOURS_MESSAGE =
  'Onze medewerkers zijn nu niet bereikbaar. Laat je e-mailadres achter, dan nemen we zo snel mogelijk contact met je op.';

/**
 * Narrows the free-form `projects.settings` jsonb blob down to the two A1
 * fields this service cares about, tolerating any garbage/missing shape
 * (settings is user/agent-editable jsonb, never trust its structure).
 */
function readBusinessHoursSettings(settings: Record<string, unknown>): {
  businessHours?: BusinessHours;
  afterHoursMessage?: string;
} {
  const rawHours = settings.businessHours;
  let businessHours: BusinessHours | undefined;
  if (
    rawHours &&
    typeof rawHours === 'object' &&
    typeof (rawHours as { timezone?: unknown }).timezone === 'string' &&
    Array.isArray((rawHours as { intervals?: unknown }).intervals)
  ) {
    businessHours = rawHours as BusinessHours;
  }
  const rawMessage = settings.afterHoursMessage;
  const afterHoursMessage =
    typeof rawMessage === 'string' && rawMessage.length > 0
      ? rawMessage
      : undefined;
  return { businessHours, afterHoursMessage };
}

export interface ConversationSummary {
  id: string;
  projectId: string;
  status: string;
  language: string;
  startedAt: string;
  updatedAt: string;
  assignedAgentId: string | null;
}

/**
 * Optional inbox filter, already resolved to a concrete predicate by the
 * caller (the controller resolves 'me' to the current user's id before
 * calling in — the service itself has no notion of "the calling agent").
 */
export type AssigneeFilter = { userId: string } | 'unassigned';

function generateVisitorSecret(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Constant-time comparison of two secrets. Both sides are first hashed to a
 * fixed-length digest so `timingSafeEqual` never throws on a length mismatch
 * (which would otherwise leak the true secret's length via an exception vs.
 * normal-return timing difference), and a plain `===` is never used for
 * secret comparison.
 */
function secretsMatch(a: string, b: string): boolean {
  const ah = createHash('sha256').update(a).digest();
  const bh = createHash('sha256').update(b).digest();
  return timingSafeEqual(ah, bh);
}

export interface MessageRow {
  id: string;
  role: string;
  content: string;
  confidence: number | null;
  refused: boolean;
  createdAt: string;
}

@Injectable()
export class ConversationsService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly answers: AnswerService,
    private readonly webhooks: WebhooksService,
    private readonly usage: UsageService,
    private readonly events: EventEmitter2,
    private readonly metrics: MetricsService,
    private readonly presence: PresenceService,
    private readonly memberships: MembershipsService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  private emit(
    tenantId: string,
    projectId: string,
    conversationId: string,
    role: string,
    content: string,
  ): void {
    this.events.emit(CHAT_MESSAGE_EVENT, {
      tenantId,
      projectId,
      conversationId,
      role,
      content,
    });
  }

  async start(
    schemaName: string,
    projectId: string,
    input: { visitorId?: string; language?: string },
  ): Promise<ConversationSummary & { visitorSecret: string }> {
    const visitorSecret = generateVisitorSecret();
    const row = await this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`INSERT INTO conversations (project_id, visitor_id, language, visitor_secret)
            VALUES (${projectId}, ${input.visitorId ?? null}, ${input.language ?? 'nl'}, ${visitorSecret})
            RETURNING *`,
      );
      return r.rows[0];
    });
    return { ...this.mapConversation(row), visitorSecret };
  }

  /**
   * Posts a visitor message. If the conversation is bot-driven, runs the RAG
   * answer pipeline, persists the bot reply + citations, and surfaces whether
   * escalation to a human is suggested (low-confidence refusal). When the
   * conversation is already in handover, the message is stored for the agent.
   *
   * Frustration/sentiment auto-escalation (#24): after the bot answer is
   * stored, if the conversation is still bot-driven and
   * `frustrationAutoEscalateEnabled`, checks whether the visitor's latest
   * message (or a run of consecutive bot refusals ending in this answer)
   * signals frustration and, if so, auto-escalates via the existing
   * `escalate` flow (same handover row / system message / business-hours
   * behavior as a visitor-initiated escalate). The bot's answer is still
   * returned to the visitor either way — auto-escalation only additionally
   * flips the conversation to handover and is surfaced via `autoEscalated`.
   */
  async postVisitorMessage(
    tenantId: string,
    schemaName: string,
    projectId: string,
    conversationId: string,
    text: string,
    visitorSecret: string,
  ): Promise<{
    status: string;
    reply?: {
      content: string;
      confidence: number;
      refused: boolean;
      escalationSuggested: boolean;
      autoEscalated: boolean;
      citations: { documentTitle: string; documentId: string }[];
    };
  }> {
    const convo = await this.requireConversationForVisitor(
      schemaName,
      projectId,
      conversationId,
      visitorSecret,
    );
    await this.insertMessage(schemaName, conversationId, {
      role: 'visitor',
      content: text,
    });
    this.emit(tenantId, projectId, conversationId, 'visitor', text);

    if (convo.status !== 'bot') {
      return { status: convo.status };
    }

    // Cost cap: reserve capacity atomically before the LLM round-trip so an
    // over-quota tenant cannot keep driving paid AI answers, and concurrent
    // requests can't all slip through on a stale read (TOCTOU).
    await this.usage.reserveAnswer(tenantId);
    const started = Date.now();
    const answer = await this.answers.answer(schemaName, projectId, text);
    const latency = Date.now() - started;

    await this.tenantDb.withTenant(schemaName, async (db) => {
      const m = await db.execute(
        sql`INSERT INTO messages (conversation_id, role, content, confidence, refused, latency_ms)
            VALUES (${conversationId}, 'bot', ${answer.answer}, ${answer.confidence}, ${answer.refused}, ${latency})
            RETURNING id`,
      );
      const messageId = (m.rows[0] as { id: string }).id;
      for (const c of answer.citations) {
        await db.execute(
          sql`INSERT INTO message_citations (message_id, ordinal, chunk_id, document_id, document_title, source_id, origin_url)
              VALUES (${messageId}, ${c.index}, ${c.chunkId}, ${c.documentId}, ${c.documentTitle}, ${c.sourceId}, ${c.originUrl})`,
        );
      }
      await db.execute(
        sql`UPDATE conversations SET updated_at=now() WHERE id=${conversationId}`,
      );
    });
    this.emit(tenantId, projectId, conversationId, 'bot', answer.answer);

    let autoEscalated = false;
    let status = 'bot';
    if (this.cfg.frustrationAutoEscalateEnabled) {
      const consecutiveRefusals = await this.countTrailingRefusedBotMessages(
        schemaName,
        conversationId,
      );
      if (
        isFrustrated({
          latestVisitorText: text,
          consecutiveRefusals,
          refusalStreakThreshold: this.cfg.frustrationRefusalStreak,
        })
      ) {
        await this.escalate(
          tenantId,
          schemaName,
          projectId,
          conversationId,
          'auto: frustration',
          visitorSecret,
        );
        autoEscalated = true;
        status = 'handover';
      }
    }

    return {
      status,
      reply: {
        content: answer.answer,
        confidence: answer.confidence,
        refused: answer.refused,
        escalationSuggested: answer.escalationSuggested,
        autoEscalated,
        citations: answer.citations.map((c) => ({
          documentTitle: c.documentTitle,
          documentId: c.documentId,
        })),
      },
    };
  }

  /**
   * Counts the leading run of `refused = true` bot messages, most-recent
   * first, over the last ~10 bot messages in the conversation (small bound so
   * this stays a cheap indexed lookup, not an unbounded scan). This is the
   * "consecutive refusal streak" used by the frustration heuristic — it
   * naturally resets to 0 as soon as a non-refused bot answer is found,
   * since the run stops there.
   */
  private async countTrailingRefusedBotMessages(
    schemaName: string,
    conversationId: string,
  ): Promise<number> {
    const rows = await this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`SELECT refused FROM messages
            WHERE conversation_id = ${conversationId} AND role = 'bot'
            ORDER BY created_at DESC
            LIMIT 10`,
      );
      return r.rows as { refused: boolean }[];
    });
    let count = 0;
    for (const row of rows) {
      if (!row.refused) break;
      count++;
    }
    return count;
  }

  async escalate(
    tenantId: string,
    schemaName: string,
    projectId: string,
    conversationId: string,
    reason: string,
    visitorSecret: string,
  ): Promise<{ afterHours: boolean; assignedAgentId: string | null }> {
    const convo = await this.requireConversationForVisitor(
      schemaName,
      projectId,
      conversationId,
      visitorSecret,
    );
    // Idempotency: a conversation already in handover is left untouched, but
    // still reports whether "now" is after-hours so a caller polling this
    // response gets a consistent answer either way.
    if (convo.status === 'handover') {
      const settings = await this.loadProjectSettings(schemaName, projectId);
      const { businessHours } = readBusinessHoursSettings(settings);
      return {
        afterHours: !isOpen(businessHours, new Date()),
        assignedAgentId: convo.assignedAgentId,
      };
    }

    const settings = await this.loadProjectSettings(schemaName, projectId);
    const { businessHours, afterHoursMessage } =
      readBusinessHoursSettings(settings);
    const afterHours = !isOpen(businessHours, new Date());
    const botMessage = afterHours
      ? (afterHoursMessage ?? DEFAULT_AFTER_HOURS_MESSAGE)
      : DEFAULT_HANDOVER_MESSAGE;
    // The handovers row still always gets inserted (so it lands in the agent
    // inbox to be handled later, regardless of hours) — only the posted bot
    // message and the reported `afterHours` flag change. `afterHours` is
    // recorded on the existing `reason` column (no schema change) so it's
    // visible to anyone inspecting the handover record.
    const storedReason = afterHours ? `${reason} (after-hours)` : reason;

    // Auto-assignment (#21): pick the least-busy currently-available agent
    // (fewest open handover conversations already assigned to them in this
    // tenant), so new escalations don't pile up on whoever happened to be
    // first available. If nobody is available, leave it unassigned — it
    // still lands in the inbox for anyone to claim via `assign`.
    const assignedAgentId = await this.pickLeastBusyAgent(
      tenantId,
      schemaName,
      projectId,
    );

    await this.tenantDb.withTenant(schemaName, async (db) => {
      await db.execute(
        sql`UPDATE conversations SET status='handover', assigned_agent_id=${assignedAgentId}, updated_at=now() WHERE id=${conversationId}`,
      );
      await db.execute(
        sql`INSERT INTO handovers (conversation_id, agent_user_id, reason) VALUES (${conversationId}, ${assignedAgentId}, ${storedReason})`,
      );
      await db.execute(
        sql`INSERT INTO messages (conversation_id, role, content)
            VALUES (${conversationId}, 'system', ${botMessage})`,
      );
    });
    this.metrics.escalationsTotal.inc();
    this.emit(tenantId, projectId, conversationId, 'system', botMessage);
    await this.webhooks.dispatch(
      schemaName,
      projectId,
      'conversation.escalated',
      {
        conversationId,
        reason: storedReason,
        afterHours,
        assignedAgentId,
      },
    );
    return { afterHours, assignedAgentId };
  }

  /**
   * Picks the least-busy available agent: among users PresenceService
   * reports as available (fresh + role >= agent), the one currently
   * assigned the fewest open (`status='handover'`) conversations in this
   * project's tenant schema. Returns null when no one is available.
   */
  private async pickLeastBusyAgent(
    tenantId: string,
    schemaName: string,
    projectId: string,
  ): Promise<string | null> {
    const available = await this.presence.listAvailable(tenantId);
    if (available.length === 0) return null;
    if (available.length === 1) return available[0];

    const counts = await this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`SELECT assigned_agent_id, count(*) AS open_count
            FROM conversations
            WHERE project_id = ${projectId}
              AND status = 'handover'
              AND assigned_agent_id IS NOT NULL
            GROUP BY assigned_agent_id`,
      );
      return r.rows as { assigned_agent_id: string; open_count: string }[];
    });
    const openCountByAgent = new Map<string, number>(
      counts.map((row) => [row.assigned_agent_id, Number(row.open_count)]),
    );

    let best = available[0];
    let bestCount = openCountByAgent.get(best) ?? 0;
    for (const candidate of available.slice(1)) {
      const count = openCountByAgent.get(candidate) ?? 0;
      if (count < bestCount) {
        best = candidate;
        bestCount = count;
      }
    }
    return best;
  }

  /**
   * Claims or reassigns a conversation to `agentUserId` (self-claim when the
   * caller assigns themselves). Audits `conversation.assigned`.
   */
  async assign(
    tenantId: string,
    schemaName: string,
    projectId: string,
    conversationId: string,
    agentUserId: string,
    actorUserId: string,
  ): Promise<ConversationSummary> {
    await this.requireConversation(schemaName, projectId, conversationId);
    const row = await this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`UPDATE conversations SET assigned_agent_id=${agentUserId}, updated_at=now()
            WHERE id=${conversationId} AND project_id=${projectId}
            RETURNING *`,
      );
      const updated = r.rows[0];
      if (!updated) throw new NotFoundException('Conversation not found');
      await this.audit.record(
        {
          tenantId,
          actorUserId,
          action: 'conversation.assigned',
          resource: `conversation:${conversationId}`,
          metadata: { assignedAgentId: agentUserId },
        },
        db,
      );
      return updated;
    });
    return this.mapConversation(row);
  }

  /**
   * Transfers (reassigns) an assigned conversation from its current agent to
   * another agent, with an optional note (#39). Reuses the #21 assignment
   * mechanism (`conversations.assigned_agent_id`) for the effective handoff,
   * and additionally records an immutable `conversation_transfers` history
   * row so who-moved-what-to-whom is auditable. The note, when present, is
   * both stored on the transfer row and posted into the thread as a `system`
   * message so the receiving agent sees the context inline.
   *
   * Guardrails:
   * - the conversation must currently be in `handover` (you can't hand off a
   *   bot-driven or closed conversation to an agent);
   * - the target must be a member of this tenant holding at least the `agent`
   *   role (you can't transfer to a viewer or a non-member);
   * - transferring to the agent it's already assigned to is a no-op error
   *   (nothing to transfer).
   */
  async transfer(
    tenantId: string,
    schemaName: string,
    projectId: string,
    conversationId: string,
    toAgentUserId: string,
    actorUserId: string,
    note?: string,
  ): Promise<ConversationSummary> {
    const convo = await this.requireConversation(
      schemaName,
      projectId,
      conversationId,
    );
    if (convo.status !== 'handover') {
      throw new BadRequestException(
        'Only a conversation in handover can be transferred',
      );
    }
    if (convo.assignedAgentId === toAgentUserId) {
      throw new BadRequestException(
        'Conversation is already assigned to that agent',
      );
    }
    const membership = await this.memberships.find(tenantId, toAgentUserId);
    if (!membership || ROLE_RANK[membership.role] < ROLE_RANK['agent']) {
      throw new BadRequestException(
        'Transfer target must be an agent of this tenant',
      );
    }

    const fromAgentUserId = convo.assignedAgentId;
    const row = await this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`UPDATE conversations SET assigned_agent_id=${toAgentUserId}, updated_at=now()
            WHERE id=${conversationId} AND project_id=${projectId}
            RETURNING *`,
      );
      const updated = r.rows[0];
      if (!updated) throw new NotFoundException('Conversation not found');
      await db.execute(
        sql`INSERT INTO conversation_transfers
              (conversation_id, from_agent_user_id, to_agent_user_id, transferred_by_user_id, note)
            VALUES (${conversationId}, ${fromAgentUserId}, ${toAgentUserId}, ${actorUserId}, ${note ?? null})`,
      );
      // Keep the open handover row's agent in sync so the inbox and handover
      // history agree on who currently owns the conversation.
      await db.execute(
        sql`UPDATE handovers SET agent_user_id=${toAgentUserId}
            WHERE conversation_id=${conversationId} AND returned_at IS NULL`,
      );
      if (note) {
        await db.execute(
          sql`INSERT INTO messages (conversation_id, role, content)
              VALUES (${conversationId}, 'system', ${note})`,
        );
      }
      await this.audit.record(
        {
          tenantId,
          actorUserId,
          action: 'conversation.transferred',
          resource: `conversation:${conversationId}`,
          metadata: { fromAgentUserId, toAgentUserId, note: note ?? null },
        },
        db,
      );
      return updated;
    });
    if (note) {
      this.emit(tenantId, projectId, conversationId, 'system', note);
    }
    return this.mapConversation(row);
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

  async listInbox(
    schemaName: string,
    projectId: string,
    status: string,
    assignee?: AssigneeFilter,
  ): Promise<ConversationSummary[]> {
    return this.tenantDb.withTenant(schemaName, async (db) => {
      const assigneeClause =
        assignee === 'unassigned'
          ? sql`AND assigned_agent_id IS NULL`
          : assignee !== undefined
            ? sql`AND assigned_agent_id = ${assignee.userId}`
            : sql``;
      const r = await db.execute(
        sql`SELECT * FROM conversations WHERE project_id=${projectId} AND status=${status} ${assigneeClause} ORDER BY updated_at DESC`,
      );
      return r.rows.map((row) => this.mapConversation(row));
    });
  }

  async getWithMessages(
    schemaName: string,
    projectId: string,
    conversationId: string,
  ): Promise<{ conversation: ConversationSummary; messages: MessageRow[] }> {
    const convo = await this.requireConversation(
      schemaName,
      projectId,
      conversationId,
    );
    const messages = await this.fetchMessages(schemaName, conversationId);
    return { conversation: convo, messages };
  }

  /**
   * Visitor-facing history reload: same shape as `getWithMessages`, but
   * ownership is proven by the per-conversation visitor secret (issued once,
   * at `start`) rather than by OIDC session + tenant membership.
   */
  async getWithMessagesForVisitor(
    schemaName: string,
    projectId: string,
    conversationId: string,
    visitorSecret: string,
  ): Promise<{ conversation: ConversationSummary; messages: MessageRow[] }> {
    const convo = await this.requireConversationForVisitor(
      schemaName,
      projectId,
      conversationId,
      visitorSecret,
    );
    const messages = await this.fetchMessages(schemaName, conversationId);
    return { conversation: convo, messages };
  }

  private async fetchMessages(
    schemaName: string,
    conversationId: string,
  ): Promise<MessageRow[]> {
    return this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`SELECT id, role, content, confidence, refused, created_at
            FROM messages WHERE conversation_id=${conversationId} ORDER BY created_at`,
      );
      return r.rows.map((row) => ({
        id: row.id as string,
        role: row.role as string,
        content: row.content as string,
        confidence: row.confidence == null ? null : Number(row.confidence),
        refused: Boolean(row.refused),
        createdAt: String(row.created_at),
      }));
    });
  }

  async agentMessage(
    tenantId: string,
    schemaName: string,
    projectId: string,
    conversationId: string,
    agentUserId: string,
    text: string,
  ): Promise<void> {
    const convo = await this.requireConversation(
      schemaName,
      projectId,
      conversationId,
    );
    if (convo.status !== 'handover') {
      throw new NotFoundException('Conversation is not in handover');
    }
    await this.tenantDb.withTenant(schemaName, async (db) => {
      await db.execute(
        sql`INSERT INTO messages (conversation_id, role, content, agent_user_id)
            VALUES (${conversationId}, 'agent', ${text}, ${agentUserId})`,
      );
      await db.execute(
        sql`UPDATE handovers SET agent_user_id=${agentUserId}
            WHERE conversation_id=${conversationId} AND returned_at IS NULL`,
      );
      await db.execute(
        sql`UPDATE conversations SET updated_at=now() WHERE id=${conversationId}`,
      );
    });
    this.emit(tenantId, projectId, conversationId, 'agent', text);
  }

  async returnToBot(
    schemaName: string,
    projectId: string,
    conversationId: string,
  ): Promise<void> {
    await this.requireConversation(schemaName, projectId, conversationId);
    await this.tenantDb.withTenant(schemaName, async (db) => {
      await db.execute(
        sql`UPDATE conversations SET status='bot', updated_at=now() WHERE id=${conversationId}`,
      );
      await db.execute(
        sql`UPDATE handovers SET returned_at=now()
            WHERE conversation_id=${conversationId} AND returned_at IS NULL`,
      );
    });
  }

  private async insertMessage(
    schemaName: string,
    conversationId: string,
    msg: { role: string; content: string },
  ): Promise<void> {
    await this.tenantDb.withTenant(schemaName, (db) =>
      db.execute(
        sql`INSERT INTO messages (conversation_id, role, content)
            VALUES (${conversationId}, ${msg.role}, ${msg.content})`,
      ),
    );
  }

  private async requireConversation(
    schemaName: string,
    projectId: string,
    conversationId: string,
  ): Promise<ConversationSummary> {
    const rows = await this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`SELECT * FROM conversations WHERE id=${conversationId} AND project_id=${projectId}`,
      );
      return r.rows;
    });
    if (!rows[0]) throw new NotFoundException('Conversation not found');
    return this.mapConversation(rows[0]);
  }

  /**
   * Visitor-scoped lookup: id+project not found -> 404 (NotFoundException);
   * found but the supplied visitor secret doesn't match the row's
   * `visitor_secret` -> 401 (UnauthorizedException). A wrong secret must
   * never leak conversation data (no partial fields, no distinguishing the
   * two failure modes to the caller beyond the status code).
   */
  private async requireConversationForVisitor(
    schemaName: string,
    projectId: string,
    conversationId: string,
    visitorSecret: string,
  ): Promise<ConversationSummary> {
    const rows = await this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`SELECT * FROM conversations WHERE id=${conversationId} AND project_id=${projectId}`,
      );
      return r.rows;
    });
    const row = rows[0];
    if (!row) throw new NotFoundException('Conversation not found');
    const storedSecret = row.visitor_secret as string;
    if (
      !visitorSecret ||
      !storedSecret ||
      !secretsMatch(visitorSecret, storedSecret)
    ) {
      throw new UnauthorizedException('Invalid visitor secret');
    }
    return this.mapConversation(row);
  }

  /**
   * Visitor submits (or overwrites — idempotent) a CSAT rating for the whole
   * conversation. Ownership is proven the same way as every other
   * visitor-facing mutation: id+project lookup, then constant-time secret
   * comparison via `requireConversationForVisitor` (404 unknown id, 401
   * wrong/missing secret, and in both cases nothing is written).
   */
  async submitCsat(
    schemaName: string,
    projectId: string,
    conversationId: string,
    visitorSecret: string,
    score: number,
    comment?: string,
  ): Promise<void> {
    await this.requireConversationForVisitor(
      schemaName,
      projectId,
      conversationId,
      visitorSecret,
    );
    await this.tenantDb.withTenant(schemaName, (db) =>
      db.execute(
        sql`UPDATE conversations
            SET csat_score = ${score}, csat_comment = ${comment ?? null}, updated_at = now()
            WHERE id = ${conversationId}`,
      ),
    );
  }

  /**
   * Visitor thumbs-up/down on a single bot answer. Verifies conversation
   * ownership via the visitor secret, then that `messageId` both belongs to
   * this conversation and is a bot message (visitors can't rate their own
   * messages or agent/system messages) before upserting the rating.
   */
  async submitMessageFeedback(
    schemaName: string,
    projectId: string,
    conversationId: string,
    visitorSecret: string,
    messageId: string,
    rating: 'up' | 'down',
  ): Promise<void> {
    await this.requireConversationForVisitor(
      schemaName,
      projectId,
      conversationId,
      visitorSecret,
    );
    await this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`SELECT id FROM messages
            WHERE id = ${messageId} AND conversation_id = ${conversationId} AND role = 'bot'`,
      );
      if (!r.rows[0]) {
        throw new NotFoundException('Message not found in this conversation');
      }
      await db.execute(
        sql`INSERT INTO message_feedback (message_id, rating)
            VALUES (${messageId}, ${rating})
            ON CONFLICT (message_id) DO UPDATE SET rating = EXCLUDED.rating, created_at = now()`,
      );
    });
  }

  private mapConversation(row: Record<string, unknown>): ConversationSummary {
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      status: row.status as string,
      language: row.language as string,
      startedAt: String(row.started_at),
      updatedAt: String(row.updated_at),
      assignedAgentId: (row.assigned_agent_id as string | null) ?? null,
    };
  }
}
