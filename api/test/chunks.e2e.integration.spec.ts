import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPg } from './helpers/pg';
import { buildTestApp } from './helpers/app';
import { TestIdp } from './helpers/oidc';
import { RetrievalService } from '../src/rag/retrieval.service';

interface SourceBody {
  id: string;
  status: string;
}
interface ChunkListItem {
  id: string;
  documentId: string;
  documentTitle: string;
  ordinal: number;
  section: string | null;
  preview: string;
  tokenCount: number;
}
interface ChunkBody {
  id: string;
  documentId: string;
  documentTitle: string;
  ordinal: number;
  section: string | null;
  text: string;
  tokenCount: number;
}

describe('chunk inspector e2e', () => {
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
  const chunksBase = (): string =>
    `/v1/tenants/${tenantId}/projects/${projectId}/chunks`;
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
      .send({ name: 'Acme', slug: 'acme-chunks' })
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
  }, 120000);

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('lists, fetches, edits (re-embedding + retrieval), and deletes chunks; enforces RBAC', async () => {
    // Ingest a manual document with enough text to produce >= 2 chunks.
    const paragraphs = Array.from({ length: 3 }, (_, p) =>
      Array.from({ length: 150 }, (_, i) => `alpha${p}word${i}`).join(' '),
    ).join('\n\n');
    const created = await request(app.getHttpServer())
      .post(`${knowledgeBase()}/sources`)
      .set(authOwner())
      .send({
        type: 'manual',
        name: 'Doc A',
        config: { title: 'Openingstijden', body: paragraphs, language: 'nl' },
      })
      .expect(201);
    expect((created.body as SourceBody).status).toBe('processed');

    // List chunks for the project.
    const list = await request(app.getHttpServer())
      .get(chunksBase())
      .set(authOwner())
      .expect(200);
    const chunkList = list.body as ChunkListItem[];
    expect(chunkList.length).toBeGreaterThanOrEqual(2);
    expect(chunkList[0]).toHaveProperty('id');
    expect(chunkList[0]).toHaveProperty('documentTitle', 'Openingstijden');
    expect(chunkList[0]).toHaveProperty('preview');
    expect(chunkList[0]).toHaveProperty('tokenCount');
    expect(chunkList[0].preview.length).toBeLessThanOrEqual(300);

    const documentId = chunkList[0].documentId;

    // Filter by documentId.
    const byDoc = await request(app.getHttpServer())
      .get(`${chunksBase()}?documentId=${documentId}`)
      .set(authOwner())
      .expect(200);
    expect((byDoc.body as ChunkListItem[]).length).toBe(chunkList.length);

    // Search filter q (substring on text) — searches for a token unique to
    // the second paragraph.
    const searchRes = await request(app.getHttpServer())
      .get(`${chunksBase()}?q=alpha1word0`)
      .set(authOwner())
      .expect(200);
    const searchResults = searchRes.body as ChunkListItem[];
    expect(searchResults.length).toBeGreaterThan(0);

    // limit/offset pagination.
    const paged = await request(app.getHttpServer())
      .get(`${chunksBase()}?limit=1&offset=0`)
      .set(authOwner())
      .expect(200);
    expect((paged.body as ChunkListItem[]).length).toBe(1);

    const targetChunkId = chunkList[0].id;

    // GET single chunk — full text + metadata.
    const single = await request(app.getHttpServer())
      .get(`${chunksBase()}/${targetChunkId}`)
      .set(authOwner())
      .expect(200);
    const singleBody = single.body as ChunkBody;
    expect(singleBody.id).toBe(targetChunkId);
    expect(singleBody.text.length).toBeGreaterThan(0);
    expect(singleBody.documentId).toBe(documentId);

    // RBAC: viewer can read.
    await request(app.getHttpServer())
      .get(`${chunksBase()}/${targetChunkId}`)
      .set(authViewer())
      .expect(200);

    // RBAC: viewer cannot edit -> 403.
    await request(app.getHttpServer())
      .patch(`${chunksBase()}/${targetChunkId}`)
      .set(authViewer())
      .send({ text: 'should not be allowed' })
      .expect(403);

    // Editor (owner has editor+ rank) edits the chunk's text; this must
    // re-embed it and update tsv/token_count, and it must become retrievable
    // by its NEW text via a retrieval query using a distinctive new token.
    const newText =
      'Onze winkel is geopend van maandag tot en met zaterdag, uniektokenxyz123.';
    const edited = await request(app.getHttpServer())
      .patch(`${chunksBase()}/${targetChunkId}`)
      .set(authOwner())
      .send({ text: newText })
      .expect(200);
    const editedBody = edited.body as ChunkBody;
    expect(editedBody.text).toBe(newText);
    expect(editedBody.tokenCount).toBeGreaterThan(0);

    // Confirm the stored text actually changed via a fresh GET.
    const reGet = await request(app.getHttpServer())
      .get(`${chunksBase()}/${targetChunkId}`)
      .set(authOwner())
      .expect(200);
    expect((reGet.body as ChunkBody).text).toBe(newText);

    // Confirm it's retrievable by its new text via the RAG retrieval
    // service, proving the embedding/tsv were regenerated consistently
    // (both the pgvector cosine match AND the tsvector FTS match rely on
    // this having been re-embedded/re-tsv'd, not left stale).
    const retrieval = app.get(RetrievalService);
    const retrieved = await retrieval.retrieve(
      (
        await pool.query<{ schema_name: string }>(
          `SELECT schema_name FROM tenants WHERE id = $1`,
          [tenantId],
        )
      ).rows[0].schema_name,
      projectId,
      'uniektokenxyz123',
    );
    expect(retrieved.some((r) => r.chunkId === targetChunkId)).toBe(true);

    // RBAC: viewer cannot delete -> 403.
    await request(app.getHttpServer())
      .delete(`${chunksBase()}/${targetChunkId}`)
      .set(authViewer())
      .expect(403);

    // Editor deletes the chunk.
    await request(app.getHttpServer())
      .delete(`${chunksBase()}/${targetChunkId}`)
      .set(authOwner())
      .expect(200);

    // Assert gone.
    await request(app.getHttpServer())
      .get(`${chunksBase()}/${targetChunkId}`)
      .set(authOwner())
      .expect(404);
    const listAfterDelete = await request(app.getHttpServer())
      .get(chunksBase())
      .set(authOwner())
      .expect(200);
    expect(
      (listAfterDelete.body as ChunkListItem[]).some(
        (c) => c.id === targetChunkId,
      ),
    ).toBe(false);
  });

  it('404s for cross-project chunk/document ids and validates uuid params', async () => {
    // A second project in the same tenant.
    const p2 = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/projects`)
      .set(authOwner())
      .send({ name: 'Bot2' })
      .expect(201);
    const project2Id = (p2.body as { id: string }).id;

    // Ingest into project 1.
    const created = await request(app.getHttpServer())
      .post(`${knowledgeBase()}/sources`)
      .set(authOwner())
      .send({
        type: 'manual',
        name: 'Doc B',
        config: { title: 'T', body: 'gamma delta epsilon' },
      })
      .expect(201);
    expect((created.body as SourceBody).status).toBe('processed');

    const list = await request(app.getHttpServer())
      .get(chunksBase())
      .set(authOwner())
      .expect(200);
    const chunkList = list.body as ChunkListItem[];
    const chunkId = chunkList[chunkList.length - 1].id;

    // Cross-project: same chunk id, but scoped under project2 -> 404.
    await request(app.getHttpServer())
      .get(`/v1/tenants/${tenantId}/projects/${project2Id}/chunks/${chunkId}`)
      .set(authOwner())
      .expect(404);

    // Invalid UUID -> 400 via ParseUUIDPipe.
    await request(app.getHttpServer())
      .get(`${chunksBase()}/not-a-uuid`)
      .set(authOwner())
      .expect(400);
  });
});
