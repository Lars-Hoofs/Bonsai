import { Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { TenantDbService } from '../tenancy/tenant-db.service';
import { AnswerService } from '../rag/answer.service';

export interface ConversationSummary {
  id: string;
  projectId: string;
  status: string;
  language: string;
  startedAt: string;
  updatedAt: string;
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
  ) {}

  async start(
    schemaName: string,
    projectId: string,
    input: { visitorId?: string; language?: string },
  ): Promise<ConversationSummary> {
    const row = await this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`INSERT INTO conversations (project_id, visitor_id, language)
            VALUES (${projectId}, ${input.visitorId ?? null}, ${input.language ?? 'nl'})
            RETURNING *`,
      );
      return r.rows[0];
    });
    return this.mapConversation(row);
  }

  /**
   * Posts a visitor message. If the conversation is bot-driven, runs the RAG
   * answer pipeline, persists the bot reply + citations, and surfaces whether
   * escalation to a human is suggested (low-confidence refusal). When the
   * conversation is already in handover, the message is stored for the agent.
   */
  async postVisitorMessage(
    schemaName: string,
    projectId: string,
    conversationId: string,
    text: string,
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
    const convo = await this.requireConversation(
      schemaName,
      projectId,
      conversationId,
    );
    await this.insertMessage(schemaName, conversationId, {
      role: 'visitor',
      content: text,
    });

    if (convo.status !== 'bot') {
      return { status: convo.status };
    }

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
    schemaName: string,
    projectId: string,
    conversationId: string,
    reason: string,
  ): Promise<void> {
    const convo = await this.requireConversation(
      schemaName,
      projectId,
      conversationId,
    );
    if (convo.status === 'handover') return;
    await this.tenantDb.withTenant(schemaName, async (db) => {
      await db.execute(
        sql`UPDATE conversations SET status='handover', updated_at=now() WHERE id=${conversationId}`,
      );
      await db.execute(
        sql`INSERT INTO handovers (conversation_id, reason) VALUES (${conversationId}, ${reason})`,
      );
      await db.execute(
        sql`INSERT INTO messages (conversation_id, role, content)
            VALUES (${conversationId}, 'system', 'Gesprek doorgezet naar een medewerker.')`,
      );
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
    const messages = await this.tenantDb.withTenant(schemaName, async (db) => {
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
    return { conversation: convo, messages };
  }

  async agentMessage(
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
