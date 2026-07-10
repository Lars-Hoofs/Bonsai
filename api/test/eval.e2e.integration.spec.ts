import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPg } from './helpers/pg';
import { buildTestApp } from './helpers/app';
import { TestIdp } from './helpers/oidc';

interface EvalCaseBody {
  id: string;
  question: string;
  expectRefusal: boolean;
}

interface EvalRunSummaryBody {
  runId: string;
  total: number;
  passed: number;
  results: {
    caseId: string;
    pass: boolean;
    refusalCorrect: boolean;
    citationOk: boolean;
    substringOk: boolean;
    refused: boolean;
  }[];
}

describe('evals e2e', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let idp: TestIdp;
  let ownerToken: string;
  let viewerToken: string;
  let tenantId: string;
  let projectId: string;

  const base = (): string =>
    `/v1/tenants/${tenantId}/projects/${projectId}/evals`;
  const authOwner = (): { Authorization: string } => ({
    Authorization: `Bearer ${ownerToken}`,
  });
  const authViewer = (): { Authorization: string } => ({
    Authorization: `Bearer ${viewerToken}`,
  });

  beforeAll(async () => {
    ({ container, pool } = await startPg());
    ({ app, idp } = await buildTestApp(pool));
    ownerToken = await idp.sign({ sub: 'oidc|owner', email: 'owner@acme.eu' });
    viewerToken = await idp.sign({
      sub: 'oidc|viewer',
      email: 'viewer@acme.eu',
    });

    const t = await request(app.getHttpServer())
      .post('/v1/tenants')
      .set(authOwner())
      .send({ name: 'Acme', slug: 'acme-evals' })
      .expect(201);
    tenantId = (t.body as { id: string }).id;

    const p = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/projects`)
      .set(authOwner())
      .send({ name: 'Bot', defaultLanguage: 'nl' })
      .expect(201);
    projectId = (p.body as { id: string }).id;

    // Give the project a low confidence threshold so retrieval reliably
    // clears the gate with the fake embedder/LLM, mirroring
    // rag-answer.integration.spec.ts.
    const {
      rows: [{ schema_name: schemaName }],
    } = await pool.query<{ schema_name: string }>(
      `SELECT schema_name FROM tenants WHERE id = $1`,
      [tenantId],
    );
    await pool.query(
      `UPDATE "${schemaName}".projects
       SET settings = '{"confidenceThreshold":0.1}'::jsonb WHERE id = $1`,
      [projectId],
    );

    // Register the second user (viewer) by hitting an authenticated
    // endpoint once so MembershipsService has a row to attach the invite to.
    await request(app.getHttpServer())
      .get('/v1/tenants')
      .set(authViewer())
      .expect(200);
    await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/members`)
      .set(authOwner())
      .send({ email: 'viewer@acme.eu', role: 'viewer' })
      .expect(201);

    // Seed a knowledge source so the fake pipeline can answer in-scope
    // questions (mirrors knowledge.e2e.integration.spec.ts).
    await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/projects/${projectId}/knowledge/sources`)
      .set(authOwner())
      .send({
        type: 'manual',
        name: 'Handmatig artikel',
        config: {
          title: 'Openingstijden',
          body: 'De openingstijden van onze winkel zijn maandag tot en met vrijdag van negen tot vijf uur.',
          language: 'nl',
        },
      })
      .expect(201);
  }, 120000);

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('creates, lists, and deletes eval cases', async () => {
    const created = await request(app.getHttpServer())
      .post(`${base()}/cases`)
      .set(authOwner())
      .send({
        question: 'wat zijn de openingstijden van de winkel',
        expectedSubstrings: ['antwoord'],
      })
      .expect(201);
    const body = created.body as EvalCaseBody;
    expect(body.question).toBe('wat zijn de openingstijden van de winkel');
    expect(body.expectRefusal).toBe(false);

    const list = await request(app.getHttpServer())
      .get(`${base()}/cases`)
      .set(authOwner())
      .expect(200);
    expect(list.body).toHaveLength(1);

    await request(app.getHttpServer())
      .delete(`${base()}/cases/${body.id}`)
      .set(authOwner())
      .expect(200);

    const afterDelete = await request(app.getHttpServer())
      .get(`${base()}/cases`)
      .set(authOwner())
      .expect(200);
    expect(afterDelete.body).toHaveLength(0);
  });

  it('runs the eval suite, scores cases, persists a run row, and audits eval.run; viewers cannot POST /run', async () => {
    // In-scope case: the FakeLlmProvider's grounded answer is
    // "Op basis van de kennisbank is dit het antwoord op je vraag [1]." — pick
    // a substring that reliably appears in it.
    const inScope = await request(app.getHttpServer())
      .post(`${base()}/cases`)
      .set(authOwner())
      .send({
        question: 'wat zijn de openingstijden van de winkel',
        expectRefusal: false,
        expectedSubstrings: ['kennisbank'],
      })
      .expect(201);

    // Out-of-scope case: nothing in the KB is relevant, so the confidence
    // gate refuses.
    const outOfScope = await request(app.getHttpServer())
      .post(`${base()}/cases`)
      .set(authOwner())
      .send({
        question: 'hoe werkt kwantumverstrengeling in de ruimtevaart',
        expectRefusal: true,
      })
      .expect(201);

    // Viewer cannot trigger a run (RBAC).
    await request(app.getHttpServer())
      .post(`${base()}/run`)
      .set(authViewer())
      .expect(403);

    const run = await request(app.getHttpServer())
      .post(`${base()}/run`)
      .set(authOwner())
      .expect(201);
    const summary = run.body as EvalRunSummaryBody;
    expect(summary.total).toBe(2);
    expect(summary.passed).toBe(2);

    const inScopeResult = summary.results.find(
      (r) => r.caseId === (inScope.body as EvalCaseBody).id,
    );
    expect(inScopeResult).toMatchObject({
      pass: true,
      refusalCorrect: true,
      citationOk: true,
      substringOk: true,
      refused: false,
    });

    const outOfScopeResult = summary.results.find(
      (r) => r.caseId === (outOfScope.body as EvalCaseBody).id,
    );
    expect(outOfScopeResult).toMatchObject({
      pass: true,
      refusalCorrect: true,
      refused: true,
    });

    // eval_runs row persisted.
    const runsList = await request(app.getHttpServer())
      .get(`${base()}/runs`)
      .set(authOwner())
      .expect(200);
    expect(
      (runsList.body as { id: string }[]).some((r) => r.id === summary.runId),
    ).toBe(true);

    // Audit entry written.
    const audit = await pool.query<{ resource: string }>(
      `SELECT resource FROM audit_log WHERE action = 'eval.run' AND tenant_id = $1`,
      [tenantId],
    );
    expect(audit.rows.length).toBeGreaterThan(0);
    expect(audit.rows[0].resource).toBe(`project:${projectId}`);
  });

  it('viewer can list cases and runs (read access)', async () => {
    await request(app.getHttpServer())
      .get(`${base()}/cases`)
      .set(authViewer())
      .expect(200);
    await request(app.getHttpServer())
      .get(`${base()}/runs`)
      .set(authViewer())
      .expect(200);
  });
});
