import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
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
import { CHAT_MESSAGE_EVENT } from './chat.gateway';
import { isOpen } from './business-hours';
import type { BusinessHours } from './business-hours';

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
}

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

    return {
      status: 'bot',
      reply: {
        content: answer.answer,
        confidence: answer.confidence,
        refused: answer.refused,
        escalationSuggested: answer.escalationSuggested,
        citations: answer.citations.map((c) => ({
          documentTitle: c.documentTitle,
          documentId: c.documentId,
        })),
      },
    };
  }

  async escalate(
    tenantId: string,
    schemaName: string,
    projectId: string,
    conversationId: string,
    reason: string,
    visitorSecret: string,
  ): Promise<{ afterHours: boolean }> {
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
      return { afterHours: !isOpen(businessHours, new Date()) };
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

    await this.tenantDb.withTenant(schemaName, async (db) => {
      await db.execute(
        sql`UPDATE conversations SET status='handover', updated_at=now() WHERE id=${conversationId}`,
      );
      await db.execute(
        sql`INSERT INTO handovers (conversation_id, reason) VALUES (${conversationId}, ${storedReason})`,
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
      },
    );
    return { afterHours };
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
  ): Promise<ConversationSummary[]> {
    return this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`SELECT * FROM conversations WHERE project_id=${projectId} AND status=${status} ORDER BY updated_at DESC`,
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

  private mapConversation(row: Record<string, unknown>): ConversationSummary {
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      status: row.status as string,
      language: row.language as string,
      startedAt: String(row.started_at),
      updatedAt: String(row.updated_at),
    };
  }
}
