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
interface StartBody {
  id: string;
  visitorSecret: string;
}

interface TopicEntry {
  key: string;
  label: string;
  kind: 'intent' | 'cluster';
  count: number;
  share: number;
  examples: string[];
}
interface DistributionBody {
  from: string;
  to: string;
  mode: 'intent' | 'cluster' | 'hybrid';
  totalQuestions: number;
  topics: TopicEntry[];
}
interface TrendsBody {
  from: string;
  to: string;
  mode: 'intent' | 'cluster' | 'hybrid';
  granularity: 'day' | 'week' | 'month';
  keys: { key: string; label: string; kind: string }[];
  buckets: { period: string; counts: Record<string, number>; total: number }[];
}

/**
 * Topic/intent analytics e2e (#42). Seeds a project with several visitor
 * conversations whose opening questions map onto known support intents, then
 * exercises the distribution + trends endpoints. Visitor messages are created
 * through the public widget so `messages.role='visitor'` / `conversations`
 * rows exist exactly as the production path writes them.
 */
describe('topic/intent analytics e2e (#42)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let idp: TestIdp;
  let token: string;
  let tenantId: string;
  let projectId: string;
  let widgetKey: string;

  const widgetBase = '/v1/widget/conversations';
  const auth = (): { Authorization: string } => ({
    Authorization: `Bearer ${token}`,
  });
  const topicsBase = (): string =>
    `/v1/tenants/${tenantId}/projects/${projectId}/analytics/topics`;

  async function seedQuestion(content: string): Promise<void> {
    const started = await request(app.getHttpServer())
      .post(widgetBase)
      .set('x-bonsai-key', widgetKey)
      .send({ language: 'nl' })
      .expect(201);
    const { id, visitorSecret } = started.body as StartBody;
    await request(app.getHttpServer())
      .post(`${widgetBase}/${id}/messages`)
      .set('x-bonsai-key', widgetKey)
      .set('x-bonsai-visitor-secret', visitorSecret)
      .send({ content })
      .expect(201);
  }

  beforeAll(async () => {
    ({ container, pool } = await startPg());
    ({ app, idp } = await buildTestApp(pool));
    token = await idp.sign({ sub: 'oidc|topics', email: 'topics@acme.eu' });
    const t = await request(app.getHttpServer())
      .post('/v1/tenants')
      .set(auth())
      .send({ name: 'Topics', slug: 'topics' })
      .expect(201);
    tenantId = (t.body as IdBody).id;
    const p = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/projects`)
      .set(auth())
      .send({ name: 'Bot' })
      .expect(201);
    projectId = (p.body as IdBody).id;
    const key = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/api-keys`)
      .set(auth())
      .send({ name: 'widget', kind: 'public_widget', projectId })
      .expect(201);
    widgetKey = (key.body as { key: string }).key;

    // Two clear returns questions, one shipping, one payment, and one
    // free-text question that matches no fixed intent (long tail).
    await seedQuestion('Hoe kan ik mijn bestelling retourneren?');
    await seedQuestion('Ik wil dit artikel retour sturen, hoe werkt dat?');
    await seedQuestion('Wanneer wordt mijn pakket bezorgd?');
    await seedQuestion('Kan ik met iDEAL betalen?');
    await seedQuestion('Vertel eens iets over jullie bedrijfsfilosofie');
  }, 180000);

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('returns a topic distribution scoped to the project (intent mode)', async () => {
    const res = await request(app.getHttpServer())
      .get(`${topicsBase()}?mode=intent`)
      .set(auth())
      .expect(200);
    const body = res.body as DistributionBody;

    expect(body.mode).toBe('intent');
    expect(body.totalQuestions).toBe(5);

    const returns = body.topics.find((t) => t.key === 'returns');
    expect(returns).toBeDefined();
    expect(returns?.count).toBe(2);
    expect(returns?.kind).toBe('intent');
    expect(returns?.examples.length).toBeGreaterThan(0);

    expect(body.topics.find((t) => t.key === 'shipping')?.count).toBe(1);
    expect(body.topics.find((t) => t.key === 'payment')?.count).toBe(1);
    // The bedrijfsfilosofie question matches nothing -> other.
    expect(body.topics.find((t) => t.key === 'other')?.count).toBe(1);

    // Shares sum to 1 and topics are sorted by count desc (returns first).
    const shareSum = body.topics.reduce((s, t) => s + t.share, 0);
    expect(shareSum).toBeCloseTo(1, 5);
    expect(body.topics[0].key).toBe('returns');
  });

  it('hybrid mode names intents and clusters the unmatched tail', async () => {
    const res = await request(app.getHttpServer())
      .get(`${topicsBase()}?mode=hybrid`)
      .set(auth())
      .expect(200);
    const body = res.body as DistributionBody;

    expect(body.mode).toBe('hybrid');
    expect(body.totalQuestions).toBe(5);
    // The named intents are still present as 'intent' kind...
    expect(body.topics.find((t) => t.key === 'returns')?.kind).toBe('intent');
    // ...and there is no opaque 'other' bucket: the tail is clustered.
    expect(body.topics.find((t) => t.key === 'other')).toBeUndefined();
    expect(body.topics.some((t) => t.kind === 'cluster')).toBe(true);
  });

  it('returns a trend series bucketed by day', async () => {
    const res = await request(app.getHttpServer())
      .get(`${topicsBase()}/trends?mode=intent&granularity=day`)
      .set(auth())
      .expect(200);
    const body = res.body as TrendsBody;

    expect(body.granularity).toBe('day');
    expect(body.keys.some((k) => k.key === 'returns')).toBe(true);
    const totalAcrossBuckets = body.buckets.reduce((s, b) => s + b.total, 0);
    expect(totalAcrossBuckets).toBe(5);
    // All questions were seeded now -> a single day bucket.
    const today = new Date().toISOString().slice(0, 10);
    const todayBucket = body.buckets.find((b) => b.period === today);
    expect(todayBucket).toBeDefined();
    expect(todayBucket?.counts.returns).toBe(2);
  });

  it('does not leak other projects: an empty project reports zero', async () => {
    const p2 = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/projects`)
      .set(auth())
      .send({ name: 'Empty' })
      .expect(201);
    const emptyProjectId = (p2.body as IdBody).id;
    const res = await request(app.getHttpServer())
      .get(
        `/v1/tenants/${tenantId}/projects/${emptyProjectId}/analytics/topics?mode=intent`,
      )
      .set(auth())
      .expect(200);
    const body = res.body as DistributionBody;
    expect(body.totalQuestions).toBe(0);
    expect(body.topics).toEqual([]);
  });

  it('rejects unauthenticated requests with 401', async () => {
    await request(app.getHttpServer()).get(topicsBase()).expect(401);
  });
});
