import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPg } from './helpers/pg';
import { buildTestApp } from './helpers/app';
import { TestIdp } from './helpers/oidc';

interface IdBody {
  id: string;
}

interface MonthlyUsageBody {
  period: string;
  answers: number;
  estimatedTokens: number;
  estimatedCost: number;
}

interface UsageSummaryBody {
  months: MonthlyUsageBody[];
  totalAnswers: number;
  totalEstimatedTokens: number;
  totalEstimatedCost: number;
  costPer1kTokens: number;
  estTokensPerAnswer: number;
}

describe('usage/cost analytics e2e (#43)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let idp: TestIdp;
  let token: string;
  let tenantId: string;
  let projectId: string;

  const costPer1kTokens = 0.02;
  const estTokensPerAnswer = 1500;

  const proj = (): string => `/v1/tenants/${tenantId}/projects/${projectId}`;
  const auth = (): { Authorization: string } => ({
    Authorization: `Bearer ${token}`,
  });

  beforeAll(async () => {
    ({ container, pool } = await startPg());
    ({ app, idp } = await buildTestApp(pool, {
      costPer1kTokens,
      estTokensPerAnswer,
    }));
    token = await idp.sign({ sub: 'oidc|u1', email: 'u1@acme.eu' });
    const t = await request(app.getHttpServer())
      .post('/v1/tenants')
      .set(auth())
      .send({ name: 'Acme', slug: 'acme' })
      .expect(201);
    tenantId = (t.body as IdBody).id;
    const p = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/projects`)
      .set(auth())
      .send({ name: 'Bot' })
      .expect(201);
    projectId = (p.body as IdBody).id;
  }, 120000);

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('records answers and reflects the count + estimated cost in the usage summary', async () => {
    const numAnswers = 3;
    for (let i = 0; i < numAnswers; i++) {
      await request(app.getHttpServer())
        .post(`${proj()}/answer`)
        .set(auth())
        .send({ question: `vraag nummer ${i}` })
        .expect(201);
    }

    const res = await request(app.getHttpServer())
      .get(`/v1/tenants/${tenantId}/usage/summary`)
      .set(auth())
      .expect(200);
    const body = res.body as UsageSummaryBody;

    expect(body.costPer1kTokens).toBe(costPer1kTokens);
    expect(body.estTokensPerAnswer).toBe(estTokensPerAnswer);
    expect(body.totalAnswers).toBeGreaterThanOrEqual(numAnswers);

    const currentPeriod = new Date().toISOString().slice(0, 7);
    const currentMonth = body.months.find((m) => m.period === currentPeriod);
    expect(currentMonth).toBeDefined();
    if (!currentMonth) throw new Error('expected current month entry');

    expect(currentMonth.answers).toBeGreaterThanOrEqual(numAnswers);
    expect(currentMonth.estimatedTokens).toBe(
      currentMonth.answers * estTokensPerAnswer,
    );
    expect(currentMonth.estimatedCost).toBeCloseTo(
      (currentMonth.answers * estTokensPerAnswer * costPer1kTokens) / 1000,
      6,
    );

    // Default month window includes the current period, most-recent-last.
    expect(body.months[body.months.length - 1].period).toBe(currentPeriod);
  });

  it('rejects unauthenticated requests with 401', async () => {
    await request(app.getHttpServer())
      .get(`/v1/tenants/${tenantId}/usage/summary`)
      .expect(401);
  });
});
