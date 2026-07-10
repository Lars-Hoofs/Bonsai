import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { TenantDbService } from '../tenancy/tenant-db.service';

export interface AnalyticsSummary {
  conversations: number;
  escalations: number;
  activeHandovers: number;
  botMessages: number;
  refused: number;
  refusalRate: number;
  resolutionRate: number;
  avgConfidence: number | null;
}

export interface UnansweredQuestion {
  question: string;
  count: number;
}

export interface CsatSummary {
  ratedConversations: number;
  avgScore: number | null;
  percentPositive: number;
  messageFeedbackUp: number;
  messageFeedbackDown: number;
}

// Visitor-entered free text can be arbitrarily long and may contain pasted
// PII (names, addresses, order numbers, etc.). `unanswered` surfaces this
// text verbatim to tenant staff for KB-improvement purposes, so the payload
// is bounded here to reduce the PII surface returned by the endpoint — this
// is a data-minimization measure, not a substitute for a proper DPA/consent
// review of who may view this data.
const UNANSWERED_QUESTION_MAX_LENGTH = 500;

function truncateQuestion(text: string): string {
  return text.length > UNANSWERED_QUESTION_MAX_LENGTH
    ? text.slice(0, UNANSWERED_QUESTION_MAX_LENGTH)
    : text;
}

@Injectable()
export class AnalyticsService {
  constructor(private readonly tenantDb: TenantDbService) {}

  async summary(
    schemaName: string,
    projectId: string,
  ): Promise<AnalyticsSummary> {
    return this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(sql`
        SELECT
          (SELECT count(*) FROM conversations WHERE project_id=${projectId}) AS conversations,
          (SELECT count(DISTINCT h.conversation_id) FROM handovers h
             JOIN conversations c ON c.id=h.conversation_id WHERE c.project_id=${projectId}) AS escalations,
          (SELECT count(*) FROM conversations WHERE project_id=${projectId} AND status='handover') AS active_handovers,
          (SELECT count(*) FROM messages m JOIN conversations c ON c.id=m.conversation_id
             WHERE c.project_id=${projectId} AND m.role='bot') AS bot_messages,
          (SELECT count(*) FROM messages m JOIN conversations c ON c.id=m.conversation_id
             WHERE c.project_id=${projectId} AND m.role='bot' AND m.refused) AS refused,
          (SELECT avg(confidence) FROM messages m JOIN conversations c ON c.id=m.conversation_id
             WHERE c.project_id=${projectId} AND m.role='bot' AND m.confidence IS NOT NULL) AS avg_confidence
      `);
      const row = r.rows[0];
      const conversations = Number(row.conversations);
      const escalations = Number(row.escalations);
      const botMessages = Number(row.bot_messages);
      const refused = Number(row.refused);
      return {
        conversations,
        escalations,
        activeHandovers: Number(row.active_handovers),
        botMessages,
        refused,
        refusalRate: botMessages === 0 ? 0 : refused / botMessages,
        resolutionRate:
          conversations === 0 ? 0 : 1 - escalations / conversations,
        avgConfidence:
          row.avg_confidence == null ? null : Number(row.avg_confidence),
      };
    });
  }

  /**
   * Visitor questions that led to a refused bot answer, grouped and ranked —
   * the backlog for improving the knowledge base.
   *
   * NOTE: this exposes raw visitor-entered text to tenant staff (a DPA/PII
   * consideration — the visitor's own words may include names, order
   * numbers, or other personal data). The returned `question` is truncated
   * (see UNANSWERED_QUESTION_MAX_LENGTH) so a large pasted block isn't
   * surfaced wholesale, but this is data minimization, not redaction: bound
   * the blast radius, don't rely on it as a privacy guarantee.
   */
  async unanswered(
    schemaName: string,
    projectId: string,
  ): Promise<UnansweredQuestion[]> {
    return this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(sql`
        SELECT v.content AS question, count(*)::int AS cnt
        FROM messages b
        JOIN conversations c ON c.id = b.conversation_id
        JOIN LATERAL (
          SELECT content FROM messages v2
          WHERE v2.conversation_id = b.conversation_id
            AND v2.role = 'visitor' AND v2.created_at <= b.created_at
          ORDER BY v2.created_at DESC LIMIT 1
        ) v ON true
        WHERE c.project_id = ${projectId} AND b.role = 'bot' AND b.refused
        GROUP BY v.content
        ORDER BY cnt DESC
        LIMIT 20
      `);
      return r.rows.map((row) => ({
        question: truncateQuestion(row.question as string),
        count: row.cnt as number,
      }));
    });
  }

  /**
   * CSAT summary (#23): rated-conversation count + average score over
   * conversations with a non-null `csat_score`, the share of those scored
   * >=4 ("positive"), and message-level thumbs-up/down counts from
   * `message_feedback` (joined through messages -> conversations to scope
   * by project).
   */
  async csat(schemaName: string, projectId: string): Promise<CsatSummary> {
    return this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(sql`
        SELECT
          (SELECT count(*) FROM conversations
             WHERE project_id=${projectId} AND csat_score IS NOT NULL) AS rated_conversations,
          (SELECT avg(csat_score) FROM conversations
             WHERE project_id=${projectId} AND csat_score IS NOT NULL) AS avg_score,
          (SELECT count(*) FROM conversations
             WHERE project_id=${projectId} AND csat_score >= 4) AS positive_conversations,
          (SELECT count(*) FROM message_feedback f
             JOIN messages m ON m.id = f.message_id
             JOIN conversations c ON c.id = m.conversation_id
             WHERE c.project_id=${projectId} AND f.rating = 'up') AS feedback_up,
          (SELECT count(*) FROM message_feedback f
             JOIN messages m ON m.id = f.message_id
             JOIN conversations c ON c.id = m.conversation_id
             WHERE c.project_id=${projectId} AND f.rating = 'down') AS feedback_down
      `);
      const row = r.rows[0];
      const ratedConversations = Number(row.rated_conversations);
      const positiveConversations = Number(row.positive_conversations);
      return {
        ratedConversations,
        avgScore: row.avg_score == null ? null : Number(row.avg_score),
        percentPositive:
          ratedConversations === 0
            ? 0
            : positiveConversations / ratedConversations,
        messageFeedbackUp: Number(row.feedback_up),
        messageFeedbackDown: Number(row.feedback_down),
      };
    });
  }
}
