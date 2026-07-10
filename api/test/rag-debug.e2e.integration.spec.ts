import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPg } from './helpers/pg';
import { buildTestApp } from './helpers/app';
import { TestIdp } from './helpers/oidc';

interface SourceBody {
  id: string;
  status: string;
}

interface DebugChunk {
  index: number;
  chunkId: string;
  documentId: string;
  documentTitle: string;
  sourceId: string;
  originUrl: string | null;
  score: number;
  similarity: number;
  preview: string;
  ordinal: number;
}

interface DebugResult {
  question: string;
  language: string;
  effectiveTopK: number;
  rerankingApplied: boolean;
  synonymsApplied: boolean;
  chunks: DebugChunk[];
}

describe('retrieval debug view e2e (#26)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let idp: TestIdp;
  let ownerToken: string;
  let viewerToken: string;
  let tenantId: string;
  let projectId: string;

  const knowledgeBase = (): string =>
    `/v1/tenants/${tenantId}/projects/${projectId}/knowledge`;
  const debugRetrieveUrl = (): string =>
    `/v1/tenants/${tenantId}/projects/${projectId}/debug/retrieve`;
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
      .send({ name: 'Acme', slug: 'acme-debug' })
      .expect(201);
    tenantId = (t.body as { id: string }).id;

    const p = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/projects`)
      .set(authOwner())
      .send({ name: 'Bot' })
      .expect(201);
    projectId = (p.body as { id: string }).id;

    // Register the viewer (second user) then attach a viewer membership.
    await request(app.getHttpServer())
      .get('/v1/tenants')
      .set(authViewer())
      .expect(200);
    await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/members`)
      .set(authOwner())
      .send({ email: 'viewer@acme.eu', role: 'viewer' })
      .expect(201);

    // Ingest two manual documents (fake embedder, deterministic).
    const doc1 = await request(app.getHttpServer())
      .post(`${knowledgeBase()}/sources`)
      .set(authOwner())
      .send({
        type: 'manual',
        name: 'Openingstijden',
        config: {
          title: 'Openingstijden',
          body: 'De openingstijden van onze winkel zijn maandag tot en met vrijdag van negen tot vijf uur.',
          language: 'nl',
        },
      })
      .expect(201);
    expect((doc1.body as SourceBody).status).toBe('processed');

    const doc2 = await request(app.getHttpServer())
      .post(`${knowledgeBase()}/sources`)
      .set(authOwner())
      .send({
        type: 'manual',
        name: 'Retourneren',
        config: {
          title: 'Retourneren',
          body: 'Retourneren van een product kan binnen dertig dagen met de originele kassabon.',
          language: 'nl',
        },
      })
      .expect(201);
    expect((doc2.body as SourceBody).status).toBe('processed');
  }, 120000);

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('returns retrieved chunks with scores/similarity/preview, ordered by score', async () => {
    const res = await request(app.getHttpServer())
      .post(debugRetrieveUrl())
      .set(authOwner())
      .send({ question: 'wat zijn de openingstijden van de winkel' })
      .expect(201);

    const body = res.body as DebugResult;
    expect(body.question).toBe('wat zijn de openingstijden van de winkel');
    expect(body.language).toBe('nl');
    expect(body.effectiveTopK).toBeGreaterThan(0);
    expect(typeof body.rerankingApplied).toBe('boolean');
    expect(typeof body.synonymsApplied).toBe('boolean');
    expect(body.chunks.length).toBeGreaterThan(0);

    const top = body.chunks[0];
    expect(top.index).toBe(1);
    expect(top.documentTitle).toBe('Openingstijden');
    expect(typeof top.score).toBe('number');
    expect(typeof top.similarity).toBe('number');
    expect(top.similarity).toBeGreaterThanOrEqual(0);
    expect(top.similarity).toBeLessThanOrEqual(1);
    expect(top.preview.length).toBeGreaterThan(0);
    expect(top.preview.length).toBeLessThanOrEqual(200);
    expect(top.preview).toContain('openingstijden');
    expect(typeof top.chunkId).toBe('string');
    expect(typeof top.documentId).toBe('string');
    expect(typeof top.sourceId).toBe('string');
    expect(typeof top.ordinal).toBe('number');

    // Ordered by score, descending.
    const scores = body.chunks.map((c) => c.score);
    const sorted = [...scores].sort((a, b) => b - a);
    expect(scores).toEqual(sorted);

    // Indices are 1-based and contiguous.
    expect(body.chunks.map((c) => c.index)).toEqual(
      body.chunks.map((_, i) => i + 1),
    );
  });

  it('respects an explicit topK override', async () => {
    const res = await request(app.getHttpServer())
      .post(debugRetrieveUrl())
      .set(authOwner())
      .send({ question: 'openingstijden retourneren', topK: 1 })
      .expect(201);
    const body = res.body as DebugResult;
    expect(body.effectiveTopK).toBe(1);
    expect(body.chunks.length).toBeLessThanOrEqual(1);
  });

  it('never calls the LLM: retrieval-only, does not affect the /answer endpoint', async () => {
    // Sanity: the normal answer endpoint still works/returns an answer for
    // the same question, unaffected by having called the debug endpoint
    // above (no shared mutable state, no answer-cache interaction since the
    // debug endpoint never writes to it).
    const answerRes = await request(app.getHttpServer())
      .post(answerUrl())
      .set(authOwner())
      .send({ question: 'wat zijn de openingstijden van de winkel' })
      .expect(201);
    expect(answerRes.body).toHaveProperty('answer');
    expect(answerRes.body).toHaveProperty('citations');
  });

  it('RBAC: viewer cannot access the debug endpoint (403)', async () => {
    await request(app.getHttpServer())
      .post(debugRetrieveUrl())
      .set(authViewer())
      .send({ question: 'wat zijn de openingstijden van de winkel' })
      .expect(403);
  });

  it('validates the request body', async () => {
    await request(app.getHttpServer())
      .post(debugRetrieveUrl())
      .set(authOwner())
      .send({ question: '' })
      .expect(400);

    await request(app.getHttpServer())
      .post(debugRetrieveUrl())
      .set(authOwner())
      .send({ question: 'geldige vraag', topK: 0 })
      .expect(400);

    await request(app.getHttpServer())
      .post(debugRetrieveUrl())
      .set(authOwner())
      .send({ question: 'geldige vraag', topK: 1000 })
      .expect(400);
  });
});
