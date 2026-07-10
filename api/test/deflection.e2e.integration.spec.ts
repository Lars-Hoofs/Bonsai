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
interface DeflectionPoint {
  date: string;
  conversations: number;
  deflected: number;
  handedOver: number;
  deflectionRate: number;
}
interface DeflectionBody {
  from: string;
  to: string;
  days: number;
  conversations: number;
  deflected: number;
  handedOver: number;
  deflectionRate: number;
  trend: DeflectionPoint[];
}

describe('deflection rate & trend e2e (#44)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let idp: TestIdp;
  let token: string;
  let tenantId: string;
  let projectId: string;
  let widgetKey: string;

  const proj = (): string => `/v1/tenants/${tenantId}/projects/${projectId}`;
  const widgetBase = '/v1/widget/conversations';
  const auth = (): { Authorization: string } => ({
    Authorization: `Bearer ${token}`,
  });

  const startConvo = async (): Promise<StartBody> => {
    const c = await request(app.getHttpServer())
      .post(widgetBase)
      .set('x-bonsai-key', widgetKey)
      .send({})
      .expect(201);
    return c.body as StartBody;
  };

  beforeAll(async () => {
    ({ container, pool } = await startPg());
    ({ app, idp } = await buildTestApp(pool));
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
    const key = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/api-keys`)
      .set(auth())
      .send({ name: 'widget', kind: 'public_widget', projectId })
      .expect(201);
    widgetKey = (key.body as { key: string }).key;
  }, 120000);

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('computes deflection rate over conversations with/without handover, viewer-readable', async () => {
    // Two deflected conversations (bot-only, no handover) ...
    await startConvo();
    await startConvo();
    // ... and one that gets escalated to a human (a handover row).
    const { id: convo3, visitorSecret } = await startConvo();
    await request(app.getHttpServer())
      .post(`${widgetBase}/${convo3}/escalate`)
      .set('x-bonsai-key', widgetKey)
      .set('x-bonsai-visitor-secret', visitorSecret)
      .send({ reason: 'test' })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get(`${proj()}/analytics/deflection`)
      .set(auth())
      .expect(200);
    const b = res.body as DeflectionBody;

    expect(b.days).toBe(30);
    expect(b.conversations).toBe(3);
    expect(b.handedOver).toBe(1);
    expect(b.deflected).toBe(2);
    expect(b.deflectionRate).toBeCloseTo(2 / 3, 5);

    // Dense, zero-filled series, oldest first, one point per day.
    expect(b.trend).toHaveLength(30);
    expect(b.trend[0].date).toBe(b.from);
    expect(b.trend[b.trend.length - 1].date).toBe(b.to);

    // All of today's traffic lands on the last bucket.
    const today = b.trend[b.trend.length - 1];
    expect(today.conversations).toBe(3);
    expect(today.handedOver).toBe(1);
    expect(today.deflected).toBe(2);
    expect(today.deflectionRate).toBeCloseTo(2 / 3, 5);

    // Totals equal the sum of the per-day series.
    const summed = b.trend.reduce((s, p) => s + p.conversations, 0);
    expect(summed).toBe(b.conversations);
  });

  it('honours the configurable range and clamps it', async () => {
    const wide = await request(app.getHttpServer())
      .get(`${proj()}/analytics/deflection`)
      .query({ days: 7 })
      .set(auth())
      .expect(200);
    expect((wide.body as DeflectionBody).days).toBe(7);
    expect((wide.body as DeflectionBody).trend).toHaveLength(7);

    // Over-max clamps to 365; garbage falls back to the default 30.
    const clamped = await request(app.getHttpServer())
      .get(`${proj()}/analytics/deflection`)
      .query({ days: 100000 })
      .set(auth())
      .expect(200);
    expect((clamped.body as DeflectionBody).days).toBe(365);

    const bad = await request(app.getHttpServer())
      .get(`${proj()}/analytics/deflection`)
      .query({ days: 'nope' })
      .set(auth())
      .expect(200);
    expect((bad.body as DeflectionBody).days).toBe(30);
  });
});
