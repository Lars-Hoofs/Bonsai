import { MetricsService } from './metrics.service';

describe('MetricsService', () => {
  let metrics: MetricsService;

  beforeEach(() => {
    metrics = new MetricsService();
  });

  afterEach(() => {
    metrics.onModuleDestroy();
  });

  it('renders Prometheus text with default process metrics present', async () => {
    const { body, contentType } = await metrics.render();
    expect(contentType).toBe('text/plain; version=0.0.4; charset=utf-8');
    // collectDefaultMetrics() registers process/GC/event-loop metrics such as
    // process_cpu_user_seconds_total and nodejs_eventloop_lag_seconds.
    expect(body).toContain('process_cpu_user_seconds_total');
    expect(body).toContain('nodejs_eventloop_lag_seconds');
  });

  it('reflects incremented counter values in the rendered output', async () => {
    metrics.answersTotal.inc({ refused: 'false' });
    metrics.answersTotal.inc({ refused: 'false' });
    metrics.answersTotal.inc({ refused: 'true' });

    const { body } = await metrics.render();
    expect(body).toContain('bonsai_answers_total');
    expect(body).toContain('bonsai_answers_total{refused="false"} 2');
    expect(body).toContain('bonsai_answers_total{refused="true"} 1');
  });

  it('records escalations, ingestion outcomes and rate-limit blocks', async () => {
    metrics.escalationsTotal.inc();
    metrics.ingestionTotal.inc({ status: 'processed' });
    metrics.ingestionTotal.inc({ status: 'failed' });
    metrics.rateLimitBlockedTotal.inc();

    const { body } = await metrics.render();
    expect(body).toContain('bonsai_escalations_total 1');
    expect(body).toContain('bonsai_ingestion_total{status="processed"} 1');
    expect(body).toContain('bonsai_ingestion_total{status="failed"} 1');
    expect(body).toContain('bonsai_rate_limit_blocked_total 1');
  });

  it('times HTTP requests via the httpRequestDuration histogram', async () => {
    metrics.httpRequestDuration.observe(
      { method: 'GET', route: '/v1/tenants/:id', status_code: '200' },
      0.05,
    );
    const { body } = await metrics.render();
    expect(body).toContain('bonsai_http_request_duration_seconds_bucket');
    expect(body).toContain(
      'method="GET",route="/v1/tenants/:id",status_code="200"',
    );
  });

  it('records llm and embedding provider call counters', async () => {
    metrics.llmCallsTotal.inc({ provider: 'gpt-4o-mini' });
    metrics.embeddingCallsTotal.inc({ provider: 'FakeEmbeddingProvider' });

    const { body } = await metrics.render();
    expect(body).toContain('bonsai_llm_calls_total{provider="gpt-4o-mini"} 1');
    expect(body).toContain(
      'bonsai_embedding_calls_total{provider="FakeEmbeddingProvider"} 1',
    );
  });

  it('uses a fresh, isolated registry per instance', async () => {
    const other = new MetricsService();
    other.answersTotal.inc({ refused: 'true' });

    const { body } = await metrics.render();
    expect(body).not.toContain('bonsai_answers_total{refused="true"} 1');

    other.onModuleDestroy();
  });
});
