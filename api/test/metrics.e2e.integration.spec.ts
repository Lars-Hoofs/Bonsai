import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPg } from './helpers/pg';
import { buildTestApp } from './helpers/app';

const METRICS_TOKEN = 'test-metrics-token-abc123';

describe('GET /metrics (self-hosted Prometheus scrape endpoint)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;

  beforeAll(async () => {
    ({ container, pool } = await startPg());
    ({ app } = await buildTestApp(pool, { metricsToken: METRICS_TOKEN }));
  }, 120000);

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('is excluded from the /v1 prefix', async () => {
    await request(app.getHttpServer())
      .get('/v1/metrics')
      .set('Authorization', `Bearer ${METRICS_TOKEN}`)
      .expect(404);
  });

  it('rejects requests with no token when METRICS_TOKEN is configured', async () => {
    await request(app.getHttpServer()).get('/metrics').expect(403);
  });

  it('rejects requests with the wrong token', async () => {
    await request(app.getHttpServer())
      .get('/metrics')
      .set('Authorization', 'Bearer wrong-token')
      .expect(403);
  });

  it('accepts a valid bearer token and returns Prometheus text', async () => {
    const res = await request(app.getHttpServer())
      .get('/metrics')
      .set('Authorization', `Bearer ${METRICS_TOKEN}`)
      .expect(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.text).toContain('process_cpu_user_seconds_total');
    expect(res.text).toContain('bonsai_http_request_duration_seconds');
  });

  it('accepts a valid token via the ?token= query param', async () => {
    const res = await request(app.getHttpServer())
      .get(`/metrics?token=${METRICS_TOKEN}`)
      .expect(200);
    expect(res.text).toContain('process_cpu_user_seconds_total');
  });
});

describe('GET /metrics without a configured token', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;

  beforeAll(async () => {
    ({ container, pool } = await startPg());
    // nodeEnv defaults to 'test' in buildTestApp, so an unset METRICS_TOKEN
    // must still allow access (dev/test convenience) rather than 404ing.
    ({ app } = await buildTestApp(pool));
  }, 120000);

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('is reachable with no auth outside production', async () => {
    const res = await request(app.getHttpServer()).get('/metrics').expect(200);
    expect(res.text).toContain('process_cpu_user_seconds_total');
  });
});

describe('GET /metrics in production with no token configured', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;

  beforeAll(async () => {
    ({ container, pool } = await startPg());
    ({ app } = await buildTestApp(pool, { nodeEnv: 'production' }));
  }, 120000);

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('is hard-disabled (404) since it cannot be gated safely', async () => {
    await request(app.getHttpServer()).get('/metrics').expect(404);
  });
});
