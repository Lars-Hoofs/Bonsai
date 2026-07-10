import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
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
import type { ConversationTurn } from '../rag/answer.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { UsageService } from '../usage/usage.service';
import { MetricsService } from '../metrics/metrics.service';
import { AuditService } from '../audit/audit.service';
import { PresenceService } from '../presence/presence.service';
import { MailService } from '../mail/mail.service';
import { StorageService } from '../storage/storage.service';
import { sanitizeFilename } from '../storage/sanitize-filename';
import { ModerationService } from '../moderation/moderation.service';
import { APP_CONFIG } from '../config/config';
import type { AppConfig } from '../config/config';
import { CHAT_MESSAGE_EVENT } from './chat.gateway';
import { isOpen } from './business-hours';
import type { BusinessHours } from './business-hours';
import { isFrustrated } from './frustration';
import { renderTranscript } from './transcript';
import { validateAttachment } from './attachment-validation';
import {
  computeDeadlines,
  deriveSlaState,
  isValidTransition,
  readSlaPolicy,
} from './sla';
import type { SlaState, WorkflowStatus } from './sla';

const DEFAULT_HANDOVER_MESSAGE = 'Gesprek doorgezet naar een medewerker.';
const DEFAULT_AFTER_HOURS_MESSAGE =
  'Onze medewerkers zijn nu niet bereikbaar. Laat je e-mailadres achter, dan nemen we zo snel mogelijk contact met je op.';
// Visitor-facing replies for the profanity/abuse filter (#31). 'warn' still
// invites the visitor to rephrase; 'block' is firmer. Both are posted as a
// `system` message so they render in the transcript without being attributed
// to the bot.
const PROFANITY_WARN_MESSAGE =
  'Houd de chat alsjeblieft netjes. Herformuleer je bericht zonder ongepast taalgebruik, dan help ik je graag verder.';
const PROFANITY_BLOCK_MESSAGE =
  'Dit bericht bevat ongepast taalgebruik en is niet verwerkt. Herformuleer het netjes om verder te gaan.';

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
  workflowStatus: WorkflowStatus;
  language: string;
  startedAt: string;
  updatedAt: string;
  assignedAgentId: string | null;
  sla: SlaState;
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

export interface MessageCitation {
  documentId: string;
  documentTitle: string;
  originUrl: string | null;
}

export interface MessageRowWithCitations extends MessageRow {
  citations: MessageCitation[];
}

export interface AttachmentRow {
  id: string;
  conversationId: string;
  messageId: string | null;
  filename: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
}

function mapAttachment(r: Record<string, unknown>): AttachmentRow {
  return {
    id: r.id as string,
    conversationId: r.conversation_id as string,
    messageId: (r.message_id as string | null) ?? null,
    filename: r.filename as string,
    contentType: r.content_type as string,
    sizeBytes: Number(r.size_bytes),
    createdAt: String(r.created_at),
  };
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
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly storage: StorageService,
    private readonly moderation: ModerationService,
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
    // Stamp SLA deadlines up front from the project's SLA policy (if any), so
    // breach detection is a pure comparison against `now` later on. No policy
    // => null deadlines => the conversation can never breach (#37).
    const settings = await this.loadProjectSettings(schemaName, projectId);
    const deadlines = computeDeadlines(readSlaPolicy(settings), new Date());
    const row = await this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`INSERT INTO conversations (project_id, visitor_id, language, visitor_secret, first_response_due_at, resolution_due_at)
            VALUES (${projectId}, ${input.visitorId ?? null}, ${input.language ?? 'nl'}, ${visitorSecret}, ${deadlines.firstResponseDueAt?.toISOString() ?? null}, ${deadlines.resolutionDueAt?.toISOString() ?? null})
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
   * Profanity/abuse filter (#31): before anything else, the message is
   * screened by `ModerationService` against the per-project heuristic filter.
   * On a 'block' or 'warn' policy hit the message is stored (so moderators
   * can see what was said) but the answer pipeline is skipped and a system
   * warning is returned; on 'flag' it's recorded and answered as normal.
   * When the filter is disabled/no match, behavior is exactly as before.
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
    moderation?: { action: 'warn' | 'block' | 'flag' };
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
    // Multi-turn context (#27): snapshot the visitor<->bot exchange SO FAR,
    // before this new visitor message is stored, so the answer pipeline can
    // condense a follow-up into a standalone retrieval query and see prior
    // turns as context. Read before the insert to naturally exclude the
    // current message. The AnswerService is what actually gates on the
    // per-project/global multiTurnContextEnabled flag; passing history is
    // always safe (empty/single-turn behavior is preserved when disabled).
    const history = await this.loadConversationHistory(
      schemaName,
      conversationId,
    );
    await this.insertMessage(schemaName, conversationId, {
      role: 'visitor',
      content: text,
    });
    this.emit(tenantId, projectId, conversationId, 'visitor', text);

    if (convo.status !== 'bot') {
      return { status: convo.status };
    }

    // Profanity/abuse filter — applied BEFORE the answer pipeline so an
    // abusive message never drives (paid) LLM retrieval/answer work. Only
    // 'block'/'warn' short-circuit; 'flag' records the event and falls
    // through to answer as normal.
    const screen = await this.moderation.screenVisitorMessage(
      schemaName,
      projectId,
      conversationId,
      text,
    );
    if (screen.action === 'block' || screen.action === 'warn') {
      const message =
        screen.action === 'block'
          ? PROFANITY_BLOCK_MESSAGE
          : PROFANITY_WARN_MESSAGE;
      await this.insertMessage(schemaName, conversationId, {
        role: 'system',
        content: message,
      });
      this.emit(tenantId, projectId, conversationId, 'system', message);
      return { status: 'bot', moderation: { action: screen.action } };
    }

    // Cost cap: reserve capacity atomically before the LLM round-trip so an
    // over-quota tenant cannot keep driving paid AI answers, and concurrent
    // requests can't all slip through on a stale read (TOCTOU).
    await this.usage.reserveAnswer(tenantId);
    const started = Date.now();
    const answer = await this.answers.answer(
      schemaName,
      projectId,
      text,
      history,
    );
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
      // 'flag' hits fall through to a normal answer; still surface that the
      // message was flagged for moderation.
      ...(screen.action === 'flag'
        ? { moderation: { action: 'flag' as const } }
        : {}),
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
  /**
   * Loads the recent visitor<->bot exchange for multi-turn context (#27),
   * oldest-first. Only `visitor` and `bot` roles are included (the model
   * never sees agent/system messages), and the result is capped to the most
   * recent `multiTurnMaxTurns` turns to bound prompt size/cost. Returns `[]`
   * for a brand-new conversation, which makes the AnswerService behave exactly
   * as single-turn.
   */
  private async loadConversationHistory(
    schemaName: string,
    conversationId: string,
  ): Promise<ConversationTurn[]> {
    const limit = this.cfg.multiTurnMaxTurns;
    const rows = await this.tenantDb.withTenant(schemaName, async (db) => {
      // Take the most-recent `limit` visitor/bot messages (DESC), then
      // reverse to oldest-first below so the model reads them chronologically.
      const r = await db.execute(
        sql`SELECT role, content FROM messages
            WHERE conversation_id = ${conversationId}
              AND role IN ('visitor', 'bot')
            ORDER BY created_at DESC
            LIMIT ${limit}`,
      );
      return r.rows as { role: 'visitor' | 'bot'; content: string }[];
    });
    return rows.reverse().map((r) => ({ role: r.role, content: r.content }));
  }

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
   * Transitions a conversation's agent-facing workflow status
   * (open/pending/resolved, #37). Rejects a no-op / unknown target via
   * `isValidTransition`. Resolving stamps `resolved_at` (the resolution SLA
   * milestone); moving *out* of resolved clears it (a reopened ticket is no
   * longer resolved and its resolution deadline is live again). Audited as
   * `conversation.workflow_status_changed`.
   */
  async setWorkflowStatus(
    tenantId: string,
    schemaName: string,
    projectId: string,
    conversationId: string,
    to: WorkflowStatus,
    actorUserId: string,
  ): Promise<ConversationSummary> {
    const convo = await this.requireConversation(
      schemaName,
      projectId,
      conversationId,
    );
    const from = convo.workflowStatus;
    if (!isValidTransition(from, to)) {
      throw new BadRequestException(
        `Invalid workflow status transition from '${from}' to '${to}'`,
      );
    }
    const resolvedAtExpr =
      to === 'resolved' ? sql`COALESCE(resolved_at, now())` : sql`NULL`;
    const row = await this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`UPDATE conversations
            SET workflow_status=${to}, resolved_at=${resolvedAtExpr}, updated_at=now()
            WHERE id=${conversationId} AND project_id=${projectId}
            RETURNING *`,
      );
      const updated = r.rows[0];
      if (!updated) throw new NotFoundException('Conversation not found');
      await this.audit.record(
        {
          tenantId,
          actorUserId,
          action: 'conversation.workflow_status_changed',
          resource: `conversation:${conversationId}`,
          metadata: { from, to },
        },
        db,
      );
      return updated;
    });
    await this.webhooks.dispatch(
      schemaName,
      projectId,
      'conversation.workflow_status_changed',
      { conversationId, from, to },
    );
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
    workflowStatus?: WorkflowStatus,
  ): Promise<ConversationSummary[]> {
    return this.tenantDb.withTenant(schemaName, async (db) => {
      const assigneeClause =
        assignee === 'unassigned'
          ? sql`AND assigned_agent_id IS NULL`
          : assignee !== undefined
            ? sql`AND assigned_agent_id = ${assignee.userId}`
            : sql``;
      const workflowClause =
        workflowStatus !== undefined
          ? sql`AND workflow_status = ${workflowStatus}`
          : sql``;
      const r = await db.execute(
        sql`SELECT * FROM conversations WHERE project_id=${projectId} AND status=${status} ${assigneeClause} ${workflowClause} ORDER BY updated_at DESC`,
      );
      return r.rows.map((row) => this.mapConversation(row));
    });
  }

  async getWithMessages(
    schemaName: string,
    projectId: string,
    conversationId: string,
  ): Promise<{
    conversation: ConversationSummary;
    messages: MessageRow[];
    attachments: AttachmentRow[];
  }> {
    const convo = await this.requireConversation(
      schemaName,
      projectId,
      conversationId,
    );
    const messages = await this.fetchMessages(schemaName, conversationId);
    const attachments = await this.fetchAttachments(schemaName, conversationId);
    return { conversation: convo, messages, attachments };
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
  ): Promise<{
    conversation: ConversationSummary;
    messages: MessageRow[];
    attachments: AttachmentRow[];
  }> {
    const convo = await this.requireConversationForVisitor(
      schemaName,
      projectId,
      conversationId,
      visitorSecret,
    );
    const messages = await this.fetchMessages(schemaName, conversationId);
    const attachments = await this.fetchAttachments(schemaName, conversationId);
    return { conversation: convo, messages, attachments };
  }

  private async fetchAttachments(
    schemaName: string,
    conversationId: string,
  ): Promise<AttachmentRow[]> {
    return this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`SELECT * FROM message_attachments
            WHERE conversation_id = ${conversationId}
            ORDER BY created_at`,
      );
      return r.rows.map((row) => mapAttachment(row));
    });
  }

  /**
   * Returning-visitor resume (#13): rehydrates a conversation the visitor
   * already owns after a page reload, proving ownership with the
   * per-conversation visitor secret they persisted client-side (id + secret).
   * Unlike `getWithMessagesForVisitor`, each message carries its bot
   * citations, so the widget can rebuild the full transcript — including the
   * citation chips under bot answers — exactly as it looked before the reload.
   */
  async resumeForVisitor(
    schemaName: string,
    projectId: string,
    conversationId: string,
    visitorSecret: string,
  ): Promise<{
    conversation: ConversationSummary;
    messages: MessageRowWithCitations[];
  }> {
    const convo = await this.requireConversationForVisitor(
      schemaName,
      projectId,
      conversationId,
      visitorSecret,
    );
    const messages = await this.fetchMessagesWithCitations(
      schemaName,
      conversationId,
    );
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

  /**
   * Same ordered message history as `fetchMessages`, but each bot message is
   * joined to its `message_citations` (ordered by `ordinal`) so a resuming
   * widget can re-render citation chips. Fetched in two queries (messages,
   * then all citations for the conversation) and stitched in memory to keep it
   * a single indexed scan per table rather than an N+1 per message.
   */
  private async fetchMessagesWithCitations(
    schemaName: string,
    conversationId: string,
  ): Promise<MessageRowWithCitations[]> {
    const messages = await this.fetchMessages(schemaName, conversationId);
    if (messages.length === 0) return [];
    const citationRows = await this.tenantDb.withTenant(
      schemaName,
      async (db) => {
        const r = await db.execute(
          sql`SELECT mc.message_id, mc.document_id, mc.document_title, mc.origin_url
              FROM message_citations mc
              JOIN messages m ON m.id = mc.message_id
              WHERE m.conversation_id = ${conversationId}
              ORDER BY mc.message_id, mc.ordinal`,
        );
        return r.rows as {
          message_id: string;
          document_id: string;
          document_title: string;
          origin_url: string | null;
        }[];
      },
    );
    const byMessage = new Map<string, MessageCitation[]>();
    for (const row of citationRows) {
      const list = byMessage.get(row.message_id) ?? [];
      list.push({
        documentId: row.document_id,
        documentTitle: row.document_title,
        originUrl: row.origin_url ?? null,
      });
      byMessage.set(row.message_id, list);
    }
    return messages.map((m) => ({
      ...m,
      citations: byMessage.get(m.id) ?? [],
    }));
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
      // Stamp the first-response SLA milestone on the first agent message
      // only (COALESCE keeps the earliest timestamp on later replies), so
      // the first-response deadline is measured against when a human actually
      // first replied (#37).
      await db.execute(
        sql`UPDATE conversations
            SET updated_at=now(),
                first_responded_at=COALESCE(first_responded_at, now())
            WHERE id=${conversationId}`,
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

  /**
   * "Email me this transcript" (#15): a visitor requests the full
   * conversation transcript be sent to an email address they supply.
   * Ownership is proven the same way as every other visitor-facing action —
   * id+project lookup then constant-time secret comparison via
   * `requireConversationForVisitor` (404 unknown id, 401 wrong/missing secret,
   * and in both cases no mail is sent). The transcript is rendered to text +
   * minimal HTML and sent via the self-hosted-SMTP `MailService` (a no-op
   * that only logs when SMTP is unconfigured, so dev/test never send real
   * mail). The recipient is the visitor-supplied address, NOT any stored
   * value — the caller-supplied email is validated at the DTO boundary.
   */
  async emailTranscript(
    schemaName: string,
    projectId: string,
    conversationId: string,
    visitorSecret: string,
    email: string,
  ): Promise<void> {
    const convo = await this.requireConversationForVisitor(
      schemaName,
      projectId,
      conversationId,
      visitorSecret,
    );
    const messages = await this.fetchMessages(schemaName, conversationId);
    const { subject, text, html } = renderTranscript(messages, convo.startedAt);
    await this.mail.send({ to: email, subject, text, html });
  }

  /**
   * Visitor uploads a file/image within their conversation (#14). Ownership is
   * proven the same way as every other visitor-facing mutation (id+project
   * lookup, then constant-time secret comparison). The raw bytes are stored in
   * object storage (MinIO/S3); a `messages` row (role 'visitor') anchors the
   * upload in the transcript so agents see it inline, and a
   * `message_attachments` row records the metadata + storage key.
   *
   * Type/size are validated twice: the multer interceptor caps raw bytes at
   * the route (a hard DoS guard), and `validateAttachment` re-checks the
   * declared MIME type against the allow-list and the size here (defence in
   * depth — the interceptor limit alone doesn't restrict type). Requires
   * object storage to be configured; without it there is nowhere to keep the
   * bytes, so the upload is refused rather than silently dropped.
   */
  async addVisitorAttachment(
    tenantId: string,
    schemaName: string,
    projectId: string,
    conversationId: string,
    visitorSecret: string,
    file: { filename: string; contentType: string; buffer: Buffer },
    caption?: string,
  ): Promise<AttachmentRow> {
    await this.requireConversationForVisitor(
      schemaName,
      projectId,
      conversationId,
      visitorSecret,
    );

    const validation = validateAttachment({
      contentType: file.contentType,
      sizeBytes: file.buffer.length,
    });
    if (!validation.ok) {
      throw new BadRequestException(validation.reason);
    }

    if (!this.storage.enabled) {
      throw new BadRequestException(
        'File attachments are not available (object storage not configured)',
      );
    }

    const storageKey = `${schemaName}/visitor-attachments/${conversationId}/${randomUUID()}-${sanitizeFilename(
      file.filename,
    )}`;
    await this.storage.put(storageKey, file.buffer, file.contentType);

    const attachment = await this.tenantDb.withTenant(
      schemaName,
      async (db) => {
        const content =
          caption && caption.length > 0
            ? caption
            : `[bijlage: ${file.filename}]`;
        const m = await db.execute(
          sql`INSERT INTO messages (conversation_id, role, content)
              VALUES (${conversationId}, 'visitor', ${content})
              RETURNING id`,
        );
        const messageId = (m.rows[0] as { id: string }).id;
        const a = await db.execute(
          sql`INSERT INTO message_attachments
                (conversation_id, message_id, filename, content_type, size_bytes, storage_key)
              VALUES (${conversationId}, ${messageId}, ${file.filename}, ${file.contentType}, ${file.buffer.length}, ${storageKey})
              RETURNING *`,
        );
        await db.execute(
          sql`UPDATE conversations SET updated_at=now() WHERE id=${conversationId}`,
        );
        return mapAttachment(a.rows[0]);
      },
    );

    this.emit(
      tenantId,
      projectId,
      conversationId,
      'visitor',
      caption && caption.length > 0 ? caption : `[bijlage: ${file.filename}]`,
    );

    return attachment;
  }

  /**
   * Lists a conversation's attachments (metadata only — never the bytes) for
   * an agent viewing the conversation. Membership/role is enforced upstream by
   * the guard; here we just verify the conversation belongs to the project.
   */
  async listAttachmentsForAgent(
    schemaName: string,
    projectId: string,
    conversationId: string,
  ): Promise<AttachmentRow[]> {
    await this.requireConversation(schemaName, projectId, conversationId);
    return this.fetchAttachments(schemaName, conversationId);
  }

  /**
   * Fetches one attachment's metadata + raw bytes so an agent can download it.
   * Verifies the attachment belongs to a conversation in this project before
   * reaching into object storage (so a leaked attachment id from another
   * project/tenant can't be used to pull bytes).
   */
  async getAttachmentForAgent(
    schemaName: string,
    projectId: string,
    conversationId: string,
    attachmentId: string,
  ): Promise<{ attachment: AttachmentRow; body: Buffer }> {
    const row = await this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`SELECT a.* FROM message_attachments a
            JOIN conversations c ON c.id = a.conversation_id
            WHERE a.id = ${attachmentId}
              AND a.conversation_id = ${conversationId}
              AND c.project_id = ${projectId}`,
      );
      return r.rows[0];
    });
    if (!row) throw new NotFoundException('Attachment not found');
    const attachment = mapAttachment(row);
    const body = await this.storage.get(row.storage_key as string);
    return { attachment, body };
  }

  private mapConversation(row: Record<string, unknown>): ConversationSummary {
    const toDate = (v: unknown): Date | null => {
      if (v == null) return null;
      if (v instanceof Date) return v;
      if (typeof v === 'string' || typeof v === 'number') return new Date(v);
      return null;
    };
    const sla = deriveSlaState(
      {
        firstResponseDueAt: toDate(row.first_response_due_at),
        resolutionDueAt: toDate(row.resolution_due_at),
        firstRespondedAt: toDate(row.first_responded_at),
        resolvedAt: toDate(row.resolved_at),
      },
      new Date(),
    );
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      status: row.status as string,
      workflowStatus:
        (row.workflow_status as WorkflowStatus | undefined) ?? 'open',
      language: row.language as string,
      startedAt: String(row.started_at),
      updatedAt: String(row.updated_at),
      assignedAgentId: (row.assigned_agent_id as string | null) ?? null,
      sla,
    };
  }
}
