/**
 * Pure assembly of a GDPR data-export bundle (#47), split from the service so
 * the shape/grouping can be unit-tested without a database. The service reads
 * the subject's rows from the tenant schema and hands them here; this module
 * groups messages/citations/feedback under their conversation and stamps the
 * bundle with export metadata.
 */

export interface ConversationRow {
  id: string;
  project_id: string;
  visitor_id: string | null;
  channel: string;
  status: string;
  language: string;
  resolution: string | null;
  started_at: unknown;
  ended_at: unknown;
  updated_at: unknown;
  csat_score: number | null;
  csat_comment: string | null;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  confidence: number | null;
  refused: boolean;
  model_used: string | null;
  latency_ms: number | null;
  created_at: unknown;
}

export interface CitationRow {
  message_id: string;
  ordinal: number;
  document_title: string;
  origin_url: string | null;
}

export interface FeedbackRow {
  message_id: string;
  rating: string;
  created_at: unknown;
}

export interface HandoverRow {
  id: string;
  conversation_id: string;
  reason: string | null;
  started_at: unknown;
  returned_at: unknown;
}

export interface ExportInput {
  tenantId: string;
  projectId: string;
  visitorId: string;
  conversations: ConversationRow[];
  messages: MessageRow[];
  citations: CitationRow[];
  feedback: FeedbackRow[];
  handovers: HandoverRow[];
  exportedAt: Date;
}

export interface ExportBundle {
  subject: {
    kind: 'visitor';
    tenantId: string;
    projectId: string;
    visitorId: string;
  };
  exportedAt: string;
  counts: {
    conversations: number;
    messages: number;
    handovers: number;
    feedback: number;
  };
  conversations: Array<Record<string, unknown>>;
}

/** Groups rows by a key into a Map of arrays, preserving input order. */
function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const bucket = out.get(k);
    if (bucket) bucket.push(row);
    else out.set(k, [row]);
  }
  return out;
}

/**
 * Assembles the downloadable export bundle: every conversation for the
 * subject, each with its messages (each message carrying its citations and
 * feedback) and handovers nested underneath. Deterministic given its input
 * ordering, and self-contained (no DB access) so it is trivially unit-tested.
 */
export function assembleExportBundle(input: ExportInput): ExportBundle {
  const messagesByConversation = groupBy(
    input.messages,
    (m) => m.conversation_id,
  );
  const citationsByMessage = groupBy(input.citations, (c) => c.message_id);
  const feedbackByMessage = groupBy(input.feedback, (f) => f.message_id);
  const handoversByConversation = groupBy(
    input.handovers,
    (h) => h.conversation_id,
  );

  const conversations = input.conversations.map((c) => {
    const msgs = (messagesByConversation.get(c.id) ?? []).map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      confidence: m.confidence,
      refused: m.refused,
      modelUsed: m.model_used,
      latencyMs: m.latency_ms,
      createdAt: m.created_at,
      citations: (citationsByMessage.get(m.id) ?? []).map((cit) => ({
        ordinal: cit.ordinal,
        documentTitle: cit.document_title,
        originUrl: cit.origin_url,
      })),
      feedback: (feedbackByMessage.get(m.id) ?? []).map((f) => ({
        rating: f.rating,
        createdAt: f.created_at,
      })),
    }));
    return {
      id: c.id,
      channel: c.channel,
      status: c.status,
      language: c.language,
      resolution: c.resolution,
      startedAt: c.started_at,
      endedAt: c.ended_at,
      updatedAt: c.updated_at,
      csatScore: c.csat_score,
      csatComment: c.csat_comment,
      messages: msgs,
      handovers: (handoversByConversation.get(c.id) ?? []).map((h) => ({
        id: h.id,
        reason: h.reason,
        startedAt: h.started_at,
        returnedAt: h.returned_at,
      })),
    };
  });

  return {
    subject: {
      kind: 'visitor',
      tenantId: input.tenantId,
      projectId: input.projectId,
      visitorId: input.visitorId,
    },
    exportedAt: input.exportedAt.toISOString(),
    counts: {
      conversations: input.conversations.length,
      messages: input.messages.length,
      handovers: input.handovers.length,
      feedback: input.feedback.length,
    },
    conversations,
  };
}
