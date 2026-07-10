import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPg } from './helpers/pg';
import { buildTestApp } from './helpers/app';
import { TestIdp } from './helpers/oidc';

interface TemplateBody {
  id: string;
  projectId: string;
  triggerType: 'keyword' | 'intent';
  trigger: string;
  answer: string;
  attribution: string | null;
  shortCircuit: boolean;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

interface AnswerBody {
  answer: string;
  refused: boolean;
  confidence: number;
  citations: { documentTitle: string; sourceId: string }[];
}

describe('answer-templates e2e', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let idp: TestIdp;
  let ownerToken: string;
  let viewerToken: string;
  let tenantId: string;
  let projectId: string;

  const base = (): string =>
    `/v1/tenants/${tenantId}/projects/${projectId}/answer-templates`;
  const answerUrl = (): string =>
    `/v1/tenants/${tenantId}/projects/${projectId}/answer`;
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
      .send({ name: 'Acme', slug: 'acme-answer-templates' })
      .expect(201);
    tenantId = (t.body as { id: string }).id;

    const p = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/projects`)
      .set(authOwner())
      .send({ name: 'Bot', defaultLanguage: 'nl' })
      .expect(201);
    projectId = (p.body as { id: string }).id;

    await request(app.getHttpServer())
      .get('/v1/tenants')
      .set(authViewer())
      .expect(200);
    await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/members`)
      .set(authOwner())
      .send({ email: 'viewer@acme.eu', role: 'viewer' })
      .expect(201);
  }, 120000);

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('creates a template with defaults and lists it', async () => {
    const created = await request(app.getHttpServer())
      .post(base())
      .set(authOwner())
      .send({
        triggerType: 'keyword',
        trigger: 'openingstijden',
        answer: 'Wij zijn open van maandag tot vrijdag, 9 tot 17 uur.',
        attribution: 'Klantenservice FAQ',
      })
      .expect(201);

    const body = created.body as TemplateBody;
    expect(body.triggerType).toBe('keyword');
    expect(body.trigger).toBe('openingstijden');
    expect(body.attribution).toBe('Klantenservice FAQ');
    // Defaults applied.
    expect(body.shortCircuit).toBe(true);
    expect(body.active).toBe(true);
    expect(body.projectId).toBe(projectId);

    const list = await request(app.getHttpServer())
      .get(base())
      .set(authOwner())
      .expect(200);
    expect((list.body as TemplateBody[]).some((s) => s.id === body.id)).toBe(
      true,
    );
  });

  it('rejects a duplicate trigger (case-insensitive) for the same project+type', async () => {
    await request(app.getHttpServer())
      .post(base())
      .set(authOwner())
      .send({ triggerType: 'keyword', trigger: 'garantie', answer: 'A' })
      .expect(201);

    await request(app.getHttpServer())
      .post(base())
      .set(authOwner())
      .send({ triggerType: 'keyword', trigger: 'GARANTIE', answer: 'B' })
      .expect(500);
  });

  it('updates a template', async () => {
    const created = await request(app.getHttpServer())
      .post(base())
      .set(authOwner())
      .send({ triggerType: 'keyword', trigger: 'levertijd', answer: 'oud' })
      .expect(201);
    const id = (created.body as TemplateBody).id;

    const updated = await request(app.getHttpServer())
      .patch(`${base()}/${id}`)
      .set(authOwner())
      .send({ answer: 'nieuw antwoord', active: false })
      .expect(200);
    const body = updated.body as TemplateBody;
    expect(body.answer).toBe('nieuw antwoord');
    expect(body.active).toBe(false);
    // Untouched fields are preserved.
    expect(body.trigger).toBe('levertijd');
  });

  it('deletes a template', async () => {
    const created = await request(app.getHttpServer())
      .post(base())
      .set(authOwner())
      .send({ triggerType: 'keyword', trigger: 'deleteme', answer: 'x' })
      .expect(201);
    const id = (created.body as TemplateBody).id;

    await request(app.getHttpServer())
      .delete(`${base()}/${id}`)
      .set(authOwner())
      .expect(200);

    const list = await request(app.getHttpServer())
      .get(base())
      .set(authOwner())
      .expect(200);
    expect((list.body as TemplateBody[]).some((s) => s.id === id)).toBe(false);
  });

  it('deleting a non-existent template returns 404', async () => {
    await request(app.getHttpServer())
      .delete(`${base()}/00000000-0000-0000-0000-000000000000`)
      .set(authOwner())
      .expect(404);
  });

  it('RBAC: viewer can list but cannot create, update or delete', async () => {
    await request(app.getHttpServer())
      .get(base())
      .set(authViewer())
      .expect(200);

    await request(app.getHttpServer())
      .post(base())
      .set(authViewer())
      .send({ triggerType: 'keyword', trigger: 'blocked', answer: 'x' })
      .expect(403);

    const created = await request(app.getHttpServer())
      .post(base())
      .set(authOwner())
      .send({
        triggerType: 'keyword',
        trigger: 'viewercannotedit',
        answer: 'x',
      })
      .expect(201);
    const id = (created.body as TemplateBody).id;

    await request(app.getHttpServer())
      .patch(`${base()}/${id}`)
      .set(authViewer())
      .send({ answer: 'y' })
      .expect(403);

    await request(app.getHttpServer())
      .delete(`${base()}/${id}`)
      .set(authViewer())
      .expect(403);
  });

  it('rejects an invalid triggerType', async () => {
    await request(app.getHttpServer())
      .post(base())
      .set(authOwner())
      .send({ triggerType: 'semantic', trigger: 'x', answer: 'y' })
      .expect(400);
  });

  it('writes audit rows for create/update/delete', async () => {
    const created = await request(app.getHttpServer())
      .post(base())
      .set(authOwner())
      .send({ triggerType: 'keyword', trigger: 'audited', answer: 'x' })
      .expect(201);
    const id = (created.body as TemplateBody).id;

    await request(app.getHttpServer())
      .patch(`${base()}/${id}`)
      .set(authOwner())
      .send({ answer: 'y' })
      .expect(200);
    await request(app.getHttpServer())
      .delete(`${base()}/${id}`)
      .set(authOwner())
      .expect(200);

    const audit = await pool.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE resource = $1 ORDER BY created_at`,
      [`answer_template:${id}`],
    );
    const actions = audit.rows.map((r) => r.action);
    expect(actions).toContain('answer_template.created');
    expect(actions).toContain('answer_template.updated');
    expect(actions).toContain('answer_template.deleted');
  });

  describe('answer pipeline short-circuit', () => {
    it('returns the canned answer with attribution when a keyword trigger matches (no KB needed)', async () => {
      await request(app.getHttpServer())
        .post(base())
        .set(authOwner())
        .send({
          triggerType: 'intent',
          trigger: 'retour kosten',
          answer: 'Een retour is altijd gratis binnen 30 dagen.',
          attribution: 'Retourbeleid',
        })
        .expect(201);

      const res = await request(app.getHttpServer())
        .post(answerUrl())
        .set(authOwner())
        .send({ question: 'wat zijn de kosten van een retour bij jullie?' })
        .expect(201);

      const body = res.body as AnswerBody;
      expect(body.refused).toBe(false);
      expect(body.answer).toBe('Een retour is altijd gratis binnen 30 dagen.');
      expect(body.confidence).toBe(1);
      expect(body.citations).toHaveLength(1);
      expect(body.citations[0].documentTitle).toBe('Retourbeleid');
    });

    it('does not short-circuit for a question that matches no active template (falls through to normal refusal on an empty KB)', async () => {
      const res = await request(app.getHttpServer())
        .post(answerUrl())
        .set(authOwner())
        .send({ question: 'iets totaal ongerelateerds over astrofysica' })
        .expect(201);
      const body = res.body as AnswerBody;
      // No template matched and the KB is empty, so the normal pipeline
      // refuses honestly — proving the feature is additive.
      expect(body.refused).toBe(true);
      expect(body.answer).not.toBe(
        'Een retour is altijd gratis binnen 30 dagen.',
      );
    });

    it('does not short-circuit when the matching template is inactive', async () => {
      const created = await request(app.getHttpServer())
        .post(base())
        .set(authOwner())
        .send({
          triggerType: 'keyword',
          trigger: 'zwevendtrefwoord',
          answer: 'Dit zou niet moeten verschijnen.',
          active: false,
        })
        .expect(201);
      expect((created.body as TemplateBody).active).toBe(false);

      const res = await request(app.getHttpServer())
        .post(answerUrl())
        .set(authOwner())
        .send({ question: 'vertel me iets over zwevendtrefwoord alsjeblieft' })
        .expect(201);
      const body = res.body as AnswerBody;
      expect(body.answer).not.toBe('Dit zou niet moeten verschijnen.');
      expect(body.refused).toBe(true);
    });
  });
});
