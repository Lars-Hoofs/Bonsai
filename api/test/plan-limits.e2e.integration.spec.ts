import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPg } from './helpers/pg';
import { buildTestApp } from './helpers/app';
import { TestIdp } from './helpers/oidc';
import { DEFAULT_PLAN_LIMITS } from '../src/config/config';

interface IdBody {
  id: string;
}
interface PlanBody {
  plan: string;
  limits: {
    maxProjects: number | null;
    maxSourcesPerProject: number | null;
    maxMembers: number | null;
  };
  usage: { projects: number; members: number };
}
interface ErrorBody {
  error: { status: number; message: string; requestId: string };
}

/**
 * Plan/tier limits (#50), self-managed. The built-in DEFAULT_PLAN_LIMITS
 * ('starter': maxProjects=2, maxSourcesPerProject=20, maxMembers=10) are
 * generous enough that no *other* existing e2e/integration test (which all
 * default to plan 'starter') creates more than 2 projects, 20 sources in one
 * project, or 10 members for a single tenant — so this feature is purely
 * additive there.
 *
 * To prove enforcement itself (rather than just relying on the defaults
 * never being hit elsewhere), this suite overrides PLAN_LIMITS_JSON with a
 * dedicated 'tiny' plan with very small limits and assigns it to a test
 * tenant directly via SQL (mirroring how test/usage.e2e.integration.spec.ts
 * tightens `monthly_answer_quota` for its own tenant).
 */
describe('plan/tier limits e2e', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let idp: TestIdp;
  let ownerToken: string;
  let viewerToken: string;
  let tenantId: string;

  const auth = (): { Authorization: string } => ({
    Authorization: `Bearer ${ownerToken}`,
  });
  const authViewer = (): { Authorization: string } => ({
    Authorization: `Bearer ${viewerToken}`,
  });
  const planUrl = (): string => `/v1/tenants/${tenantId}/plan`;

  beforeAll(async () => {
    ({ container, pool } = await startPg());
    ({ app, idp } = await buildTestApp(pool, {
      planLimits: {
        ...DEFAULT_PLAN_LIMITS,
        tiny: { maxProjects: 2, maxSourcesPerProject: 2, maxMembers: 2 },
      },
    }));
    ownerToken = await idp.sign({
      sub: 'oidc|plan-owner',
      email: 'plan-owner@acme.eu',
    });
    viewerToken = await idp.sign({
      sub: 'oidc|plan-viewer',
      email: 'plan-viewer@acme.eu',
    });

    const t = await request(app.getHttpServer())
      .post('/v1/tenants')
      .set(auth())
      .send({ name: 'PlanCo', slug: 'plan-co' })
      .expect(201);
    tenantId = (t.body as IdBody).id;
    await pool.query(`UPDATE tenants SET plan = 'tiny' WHERE id = $1`, [
      tenantId,
    ]);

    // Mirror the viewer user into the DB and grant it a viewer membership,
    // consuming one of the plan's 2 member slots (owner + viewer = 2/2).
    await request(app.getHttpServer())
      .get('/v1/tenants')
      .set(authViewer())
      .expect(200);
    await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/members`)
      .set(auth())
      .send({ email: 'plan-viewer@acme.eu', role: 'viewer' })
      .expect(201);
  }, 120000);

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('GET /plan requires at least viewer role', async () => {
    const strangerToken = await idp.sign({
      sub: 'oidc|plan-stranger',
      email: 'plan-stranger@x.eu',
    });
    await request(app.getHttpServer())
      .get(planUrl())
      .set({ Authorization: `Bearer ${strangerToken}` })
      .expect(403);
  });

  it('viewer can read the plan view', async () => {
    const res = await request(app.getHttpServer())
      .get(planUrl())
      .set(authViewer())
      .expect(200);
    const body = res.body as PlanBody;
    expect(body.plan).toBe('tiny');
    expect(body.limits).toEqual({
      maxProjects: 2,
      maxSourcesPerProject: 2,
      maxMembers: 2,
    });
    expect(body.usage.members).toBe(2);
  });

  it('enforces maxMembers: adding a 3rd member is rejected with a plan-limit message', async () => {
    const thirdToken = await idp.sign({
      sub: 'oidc|plan-third',
      email: 'plan-third@x.eu',
    });
    await request(app.getHttpServer())
      .get('/v1/tenants')
      .set({ Authorization: `Bearer ${thirdToken}` })
      .expect(200);

    const res = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/members`)
      .set(auth())
      .send({ email: 'plan-third@x.eu', role: 'viewer' })
      .expect(403);
    expect((res.body as ErrorBody).error.message).toMatch(/Plan limit reached/);
  });

  let projectId: string;
  let secondProjectId: string;

  it('enforces maxProjects: 2 projects succeed, 3rd is rejected with a plan-limit message', async () => {
    const p1 = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/projects`)
      .set(auth())
      .send({ name: 'Bot One' })
      .expect(201);
    projectId = (p1.body as IdBody).id;

    const p2 = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/projects`)
      .set(auth())
      .send({ name: 'Bot Two' })
      .expect(201);
    secondProjectId = (p2.body as IdBody).id;

    const p3 = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/projects`)
      .set(auth())
      .send({ name: 'Bot Three' })
      .expect(403);
    expect((p3.body as ErrorBody).error.message).toMatch(/Plan limit reached/);
  });

  it('GET /plan reflects project usage as 2/2', async () => {
    const res = await request(app.getHttpServer())
      .get(planUrl())
      .set(authViewer())
      .expect(200);
    expect((res.body as PlanBody).usage.projects).toBe(2);
  });

  it('enforces maxSourcesPerProject: 2 sources succeed, 3rd is rejected with a plan-limit message', async () => {
    const sourcesUrl = `/v1/tenants/${tenantId}/projects/${projectId}/knowledge/sources`;
    await request(app.getHttpServer())
      .post(sourcesUrl)
      .set(auth())
      .send({
        type: 'manual',
        name: 'Source One',
        config: { title: 'One', body: 'een twee drie' },
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(sourcesUrl)
      .set(auth())
      .send({
        type: 'manual',
        name: 'Source Two',
        config: { title: 'Two', body: 'vier vijf zes' },
      })
      .expect(201);
    const third = await request(app.getHttpServer())
      .post(sourcesUrl)
      .set(auth())
      .send({
        type: 'manual',
        name: 'Source Three',
        config: { title: 'Three', body: 'zeven acht negen' },
      })
      .expect(403);
    expect((third.body as ErrorBody).error.message).toMatch(
      /Plan limit reached/,
    );

    // The limit is per-project: a different project in the same tenant still
    // has its own fresh quota (the tenant is already at maxProjects, but the
    // *second* project — created above — hasn't had any sources yet).
    const otherProjectSourcesUrl = `/v1/tenants/${tenantId}/projects/${secondProjectId}/knowledge/sources`;
    await request(app.getHttpServer())
      .post(otherProjectSourcesUrl)
      .set(auth())
      .send({
        type: 'manual',
        name: 'Other project source',
        config: { title: 'X', body: 'tien elf twaalf' },
      })
      .expect(201);
  });

  it('enterprise plan is never limited', async () => {
    await pool.query(`UPDATE tenants SET plan = 'enterprise' WHERE id = $1`, [
      tenantId,
    ]);
    // Already at 2/2 projects under 'tiny', but 'enterprise' is unlimited.
    await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/projects`)
      .set(auth())
      .send({ name: 'Bot Four' })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get(planUrl())
      .set(authViewer())
      .expect(200);
    const body = res.body as PlanBody;
    expect(body.plan).toBe('enterprise');
    expect(body.limits).toEqual({
      maxProjects: null,
      maxSourcesPerProject: null,
      maxMembers: null,
    });
  });
});
