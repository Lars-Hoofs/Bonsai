import { Injectable, OnModuleDestroy } from '@nestjs/common';
import {
  collectDefaultMetrics,
  Counter,
  Histogram,
  Registry,
} from 'prom-client';

/** Prometheus text-exposition content type (version 0.0.4 text format). */
export const PROMETHEUS_CONTENT_TYPE =
  'text/plain; version=0.0.4; charset=utf-8';

/**
 * Owns the single in-process Prometheus `Registry` and every metric
 * instrument the API records. Self-hosted only: this exposes a scrape
 * endpoint (see MetricsController) for the operator's own Prometheus/Grafana
 * on their VPS — no paid SaaS APM is involved.
 *
 * Label cardinality guardrail: the HTTP histogram is labelled with the
 * *matched Nest route pattern* (e.g. `/v1/tenants/:id/projects`), never the
 * raw URL, so path params (ids, uuids) never explode the label space.
 */
@Injectable()
export class MetricsService implements OnModuleDestroy {
  readonly registry: Registry;

  readonly httpRequestDuration: Histogram<'method' | 'route' | 'status_code'>;
  readonly answersTotal: Counter<'refused'>;
  readonly escalationsTotal: Counter<never>;
  readonly conversationsAutoClosedTotal: Counter<never>;
  readonly ingestionTotal: Counter<'status'>;
  readonly llmCallsTotal: Counter<'provider'>;
  readonly embeddingCallsTotal: Counter<'provider'>;
  readonly rateLimitBlockedTotal: Counter<never>;

  constructor() {
    this.registry = new Registry();
    collectDefaultMetrics({ register: this.registry });

    this.httpRequestDuration = new Histogram({
      name: 'bonsai_http_request_duration_seconds',
      help: 'HTTP request duration in seconds, labelled by matched route pattern.',
      labelNames: ['method', 'route', 'status_code'],
      buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });

    this.answersTotal = new Counter({
      name: 'bonsai_answers_total',
      help: 'RAG answers produced, labelled by whether the answer was refused.',
      labelNames: ['refused'],
      registers: [this.registry],
    });

    this.escalationsTotal = new Counter({
      name: 'bonsai_escalations_total',
      help: 'Conversations escalated/handed over to a human agent.',
      registers: [this.registry],
    });

    this.conversationsAutoClosedTotal = new Counter({
      name: 'bonsai_conversations_auto_closed_total',
      help: 'Conversations closed by the idle auto-close reaper (#40).',
      registers: [this.registry],
    });

    this.ingestionTotal = new Counter({
      name: 'bonsai_ingestion_total',
      help: 'Knowledge source ingestion runs, labelled by outcome status.',
      labelNames: ['status'],
      registers: [this.registry],
    });

    this.llmCallsTotal = new Counter({
      name: 'bonsai_llm_calls_total',
      help: 'Answer-LLM completion calls, labelled by provider.',
      labelNames: ['provider'],
      registers: [this.registry],
    });

    this.embeddingCallsTotal = new Counter({
      name: 'bonsai_embedding_calls_total',
      help: 'Embedding provider calls, labelled by provider.',
      labelNames: ['provider'],
      registers: [this.registry],
    });

    this.rateLimitBlockedTotal = new Counter({
      name: 'bonsai_rate_limit_blocked_total',
      help: 'Requests rejected by the rate limiter (HTTP 429).',
      registers: [this.registry],
    });
  }

  /** Renders the current registry snapshot in Prometheus text-exposition format. */
  async render(): Promise<{ body: string; contentType: string }> {
    const body = await this.registry.metrics();
    return { body, contentType: PROMETHEUS_CONTENT_TYPE };
  }

  onModuleDestroy(): void {
    this.registry.clear();
  }
}
