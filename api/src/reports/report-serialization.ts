import type {
  AnalyticsSummary,
  CsatSummary,
} from '../analytics/analytics.service';
import type { UsageSummary } from '../usage/usage.service';

export type ReportFormat = 'csv' | 'json';

/**
 * The full data payload of an exportable project report (#45): the analytics
 * summary, the CSAT summary, and the per-month usage/cost summary, plus the
 * identifying metadata (project, tenant, when it was generated). This is the
 * canonical in-memory shape both the JSON and CSV serializers work from, so
 * the two formats never drift apart.
 */
export interface ReportData {
  projectId: string;
  tenantId: string;
  generatedAt: string;
  analytics: AnalyticsSummary;
  csat: CsatSummary;
  usage: UsageSummary;
}

/**
 * One flat metric row: a section (which grouping it belongs to), a metric
 * name, and a scalar value. The CSV serializer is deliberately a *flat*
 * `section,metric,value` table rather than a per-section wide table — the
 * report mixes single-value summaries (analytics, csat) with a repeating
 * per-month series (usage), which don't share a column layout, so a long/tidy
 * shape is the only one that represents all of it uniformly in a single CSV.
 */
export interface MetricRow {
  section: string;
  metric: string;
  value: string | number | null;
}

/** Flattens a {@link ReportData} into the long-format metric rows the CSV
 * serializer emits. Exported (and unit-tested) independently so the flattening
 * is verified without going through CSV escaping. */
export function toMetricRows(data: ReportData): MetricRow[] {
  const rows: MetricRow[] = [];
  const push = (
    section: string,
    metric: string,
    value: string | number | null,
  ): void => {
    rows.push({ section, metric, value });
  };

  push('meta', 'projectId', data.projectId);
  push('meta', 'tenantId', data.tenantId);
  push('meta', 'generatedAt', data.generatedAt);

  const a = data.analytics;
  push('analytics', 'conversations', a.conversations);
  push('analytics', 'escalations', a.escalations);
  push('analytics', 'activeHandovers', a.activeHandovers);
  push('analytics', 'botMessages', a.botMessages);
  push('analytics', 'refused', a.refused);
  push('analytics', 'refusalRate', a.refusalRate);
  push('analytics', 'resolutionRate', a.resolutionRate);
  push('analytics', 'avgConfidence', a.avgConfidence);

  const c = data.csat;
  push('csat', 'ratedConversations', c.ratedConversations);
  push('csat', 'avgScore', c.avgScore);
  push('csat', 'percentPositive', c.percentPositive);
  push('csat', 'messageFeedbackUp', c.messageFeedbackUp);
  push('csat', 'messageFeedbackDown', c.messageFeedbackDown);

  const u = data.usage;
  push('usage', 'totalAnswers', u.totalAnswers);
  push('usage', 'totalEstimatedTokens', u.totalEstimatedTokens);
  push('usage', 'totalEstimatedCost', u.totalEstimatedCost);
  push('usage', 'costPer1kTokens', u.costPer1kTokens);
  push('usage', 'estTokensPerAnswer', u.estTokensPerAnswer);
  for (const m of u.months) {
    push('usage.month', `${m.period}.answers`, m.answers);
    push('usage.month', `${m.period}.estimatedTokens`, m.estimatedTokens);
    push('usage.month', `${m.period}.estimatedCost`, m.estimatedCost);
  }

  return rows;
}

/**
 * Escapes a single CSV field per RFC 4180: a field is wrapped in double
 * quotes only if it contains a comma, a double quote, or a newline, and any
 * embedded double quote is doubled. A null value serializes to the empty
 * string (an empty, unquoted field), distinguishing "no value" from the
 * literal string "null".
 */
export function csvField(value: string | number | null): string {
  if (value === null) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Serializes report data to a CSV document (CRLF line endings, RFC 4180). */
export function toCsv(data: ReportData): string {
  const header = ['section', 'metric', 'value'];
  const lines = [header.join(',')];
  for (const row of toMetricRows(data)) {
    lines.push(
      [csvField(row.section), csvField(row.metric), csvField(row.value)].join(
        ',',
      ),
    );
  }
  return lines.join('\r\n');
}

/** Serializes report data to a pretty-printed JSON document. */
export function toJson(data: ReportData): string {
  return JSON.stringify(data, null, 2);
}

/** Serializes report data in the requested format. */
export function serializeReport(
  data: ReportData,
  format: ReportFormat,
): string {
  return format === 'csv' ? toCsv(data) : toJson(data);
}

/** MIME content type for a report format (used for HTTP + storage + mail). */
export function contentType(format: ReportFormat): string {
  return format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json';
}

/**
 * A stable, safe download filename for a generated report, e.g.
 * `report_<project8>_2026-07-10.csv`. The project id is truncated to its
 * first segment and the timestamp reduced to a date, so the name is readable
 * and filesystem/header-safe (no characters needing Content-Disposition
 * quoting).
 */
export function reportFilename(
  projectId: string,
  format: ReportFormat,
  generatedAt: string,
): string {
  const shortId = projectId.split('-')[0];
  const date = generatedAt.slice(0, 10);
  return `report_${shortId}_${date}.${format}`;
}
