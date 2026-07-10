import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { EMBEDDING_PROVIDER } from '../../knowledge/embedding/embedding-provider';
import type { EmbeddingProvider } from '../../knowledge/embedding/embedding-provider';
import { TenantDbService } from '../../tenancy/tenant-db.service';
import { classifyIntent, intentLabel } from './intent-rules';
import type { IntentKey } from './intent-rules';
import { clusterQuestions } from './topic-cluster';
import type { TopicQueryDto, TopicTrendsQueryDto } from './dto';

// A visitor question longer than this is truncated in any surfaced example, to
// bound the PII surface returned to tenant staff (mirrors AnalyticsService's
// `unanswered`). Data minimisation, not a privacy guarantee.
const EXAMPLE_MAX_LENGTH = 300;
// Default window when the caller passes neither `from` nor `to`.
const DEFAULT_WINDOW_DAYS = 30;
// Hard cap on questions pulled/embedded per request (overridable downward via
// the DTO) so a huge history can't blow up on-read compute.
const MAX_CONVERSATIONS = 5000;

interface QuestionRow {
  conversationId: string;
  content: string;
  startedAt: Date;
}

interface ClassifiedQuestion extends QuestionRow {
  intent: IntentKey;
  intentScore: number;
}

export interface TopicDistributionEntry {
  key: string;
  label: string;
  /** 'intent' for the fixed ruleset, 'cluster' for an emergent topic. */
  kind: 'intent' | 'cluster';
  count: number;
  share: number;
  examples: string[];
}

export interface TopicDistribution {
  from: string;
  to: string;
  mode: 'intent' | 'cluster' | 'hybrid';
  totalQuestions: number;
  topics: TopicDistributionEntry[];
}

export interface TopicTrendBucket {
  /** Bucket start, ISO date (YYYY-MM-DD). */
  period: string;
  counts: Record<string, number>;
  total: number;
}

export interface TopicTrends {
  from: string;
  to: string;
  mode: 'intent' | 'cluster' | 'hybrid';
  granularity: 'day' | 'week' | 'month';
  /** Topic keys present across the series, in distribution order. */
  keys: { key: string; label: string; kind: 'intent' | 'cluster' }[];
  buckets: TopicTrendBucket[];
}

function truncate(text: string): string {
  const t = text.trim();
  return t.length > EXAMPLE_MAX_LENGTH ? t.slice(0, EXAMPLE_MAX_LENGTH) : t;
}

function resolveWindow(q: { from?: string; to?: string }): {
  from: Date;
  to: Date;
} {
  const to = q.to ? new Date(q.to) : new Date();
  const from = q.from
    ? new Date(q.from)
    : new Date(to.getTime() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return { from, to };
}

@Injectable()
export class TopicsService {
  constructor(
    private readonly tenantDb: TenantDbService,
    @Inject(EMBEDDING_PROVIDER)
    private readonly embedding: EmbeddingProvider,
  ) {}

  /**
   * Pull the FIRST visitor message of each conversation in the window — the
   * question that opened the conversation, which is the best single proxy for
   * "what the visitor came for". Scoped by project via the conversations join;
   * tenant-scoped by the search_path set in withTenant.
   */
  private async fetchOpeningQuestions(
    schemaName: string,
    projectId: string,
    from: Date,
    to: Date,
    limit: number,
  ): Promise<QuestionRow[]> {
    return this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(sql`
        SELECT c.id AS conversation_id, c.started_at AS started_at, m.content AS content
        FROM conversations c
        JOIN LATERAL (
          SELECT content
          FROM messages v
          WHERE v.conversation_id = c.id AND v.role = 'visitor'
          ORDER BY v.created_at ASC
          LIMIT 1
        ) m ON true
        WHERE c.project_id = ${projectId}
          AND c.started_at >= ${from.toISOString()}
          AND c.started_at <= ${to.toISOString()}
        ORDER BY c.started_at ASC
        LIMIT ${limit}
      `);
      return r.rows.map((row) => ({
        conversationId: row.conversation_id as string,
        content: (row.content as string) ?? '',
        startedAt: new Date(row.started_at as string),
      }));
    });
  }

  private classifyAll(rows: QuestionRow[]): ClassifiedQuestion[] {
    return rows.map((row) => {
      const { key, score } = classifyIntent(row.content);
      return { ...row, intent: key, intentScore: score };
    });
  }

  /**
   * Assign a topic key + label + kind to every question, according to `mode`.
   *
   * - intent: fixed ruleset only.
   * - cluster: embedding clustering over ALL questions.
   * - hybrid (default): named intents from the ruleset, then embedding
   *   clustering of only the `other`/unmatched tail so it's not a single
   *   opaque bucket.
   */
  private async assignTopics(
    classified: ClassifiedQuestion[],
    mode: 'intent' | 'cluster' | 'hybrid',
  ): Promise<
    Map<string, { key: string; label: string; kind: 'intent' | 'cluster' }>
  > {
    const assignment = new Map<
      string,
      { key: string; label: string; kind: 'intent' | 'cluster' }
    >();

    if (mode === 'intent') {
      for (const q of classified) {
        assignment.set(q.conversationId, {
          key: q.intent,
          label: intentLabel(q.intent),
          kind: 'intent',
        });
      }
      return assignment;
    }

    const toCluster =
      mode === 'cluster'
        ? classified
        : classified.filter((q) => q.intent === 'other');

    if (mode === 'hybrid') {
      for (const q of classified) {
        if (q.intent !== 'other') {
          assignment.set(q.conversationId, {
            key: q.intent,
            label: intentLabel(q.intent),
            kind: 'intent',
          });
        }
      }
    }

    if (toCluster.length > 0) {
      const vectors = await this.embedding.embed(
        toCluster.map((q) => q.content),
      );
      const clusters = clusterQuestions(
        toCluster.map((q, i) => ({
          id: q.conversationId,
          text: q.content,
          vector: vectors[i],
        })),
      );
      for (const cluster of clusters) {
        const key = `cluster:${cluster.label}`;
        for (const id of cluster.memberIds) {
          assignment.set(id, { key, label: cluster.label, kind: 'cluster' });
        }
      }
    }

    return assignment;
  }

  async distribution(
    schemaName: string,
    projectId: string,
    query: TopicQueryDto,
  ): Promise<TopicDistribution> {
    const mode = query.mode ?? 'hybrid';
    const { from, to } = resolveWindow(query);
    const limit = Math.min(
      query.maxConversations ?? MAX_CONVERSATIONS,
      MAX_CONVERSATIONS,
    );

    const rows = await this.fetchOpeningQuestions(
      schemaName,
      projectId,
      from,
      to,
      limit,
    );
    const classified = this.classifyAll(rows);
    const assignment = await this.assignTopics(classified, mode);

    const agg = new Map<
      string,
      {
        label: string;
        kind: 'intent' | 'cluster';
        count: number;
        examples: string[];
      }
    >();
    for (const q of classified) {
      const a = assignment.get(q.conversationId);
      if (!a) continue;
      const cur = agg.get(a.key) ?? {
        label: a.label,
        kind: a.kind,
        count: 0,
        examples: [],
      };
      cur.count += 1;
      if (cur.examples.length < 3 && q.content.trim().length > 0) {
        cur.examples.push(truncate(q.content));
      }
      agg.set(a.key, cur);
    }

    const total = classified.length;
    const topics: TopicDistributionEntry[] = [...agg.entries()]
      .map(([key, v]) => ({
        key,
        label: v.label,
        kind: v.kind,
        count: v.count,
        share: total === 0 ? 0 : v.count / total,
        examples: v.examples,
      }))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      mode,
      totalQuestions: total,
      topics,
    };
  }

  async trends(
    schemaName: string,
    projectId: string,
    query: TopicTrendsQueryDto,
  ): Promise<TopicTrends> {
    const mode = query.mode ?? 'hybrid';
    const granularity = query.granularity ?? 'day';
    const { from, to } = resolveWindow(query);
    const limit = Math.min(
      query.maxConversations ?? MAX_CONVERSATIONS,
      MAX_CONVERSATIONS,
    );

    const rows = await this.fetchOpeningQuestions(
      schemaName,
      projectId,
      from,
      to,
      limit,
    );
    const classified = this.classifyAll(rows);
    const assignment = await this.assignTopics(classified, mode);

    // Overall ordering of keys (by total count) so the series is consistent.
    const totals = new Map<
      string,
      { label: string; kind: 'intent' | 'cluster'; count: number }
    >();
    for (const q of classified) {
      const a = assignment.get(q.conversationId);
      if (!a) continue;
      const cur = totals.get(a.key) ?? {
        label: a.label,
        kind: a.kind,
        count: 0,
      };
      cur.count += 1;
      totals.set(a.key, cur);
    }
    const keys = [...totals.entries()]
      .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
      .map(([key, v]) => ({ key, label: v.label, kind: v.kind }));

    const buckets = new Map<string, TopicTrendBucket>();
    for (const q of classified) {
      const a = assignment.get(q.conversationId);
      if (!a) continue;
      const period = bucketKey(q.startedAt, granularity);
      const bucket = buckets.get(period) ?? {
        period,
        counts: {},
        total: 0,
      };
      bucket.counts[a.key] = (bucket.counts[a.key] ?? 0) + 1;
      bucket.total += 1;
      buckets.set(period, bucket);
    }

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      mode,
      granularity,
      keys,
      buckets: [...buckets.values()].sort((a, b) =>
        a.period.localeCompare(b.period),
      ),
    };
  }
}

/**
 * UTC bucket start as YYYY-MM-DD. Week buckets start Monday; month buckets
 * start on the 1st. Kept in JS (not SQL) so the same date logic is used for
 * both the DB-fetched `started_at` and any future in-memory sources.
 */
export function bucketKey(
  date: Date,
  granularity: 'day' | 'week' | 'month',
): string {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  if (granularity === 'month') {
    d.setUTCDate(1);
  } else if (granularity === 'week') {
    // getUTCDay: 0=Sun..6=Sat. Shift back to Monday.
    const dow = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - dow);
  }
  return d.toISOString().slice(0, 10);
}
