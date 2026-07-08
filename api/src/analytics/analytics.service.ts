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
        question: row.question as string,
        count: row.cnt as number,
      }));
    });
  }
}
