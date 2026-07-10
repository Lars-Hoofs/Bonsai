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
interface TagBody {
  id: string;
  projectId: string;
  name: string;
  color: string | null;
}
interface SavedFilterBody {
  id: string;
  name: string;
  ownerUserId: string;
  filter: Record<string, unknown>;
}
interface SearchResult {
  id: string;
  status: string;
  tags: TagBody[];
}

/**
 * Exercises conversation tags + saved filters + search (#36) end to end:
 * seed a couple of conversations with distinct message content (which
 * populates each conversation's search_tsv via the DB trigger), then tag,
 * filter, full-text search, and save/reuse filter presets.
 */
describe('conversation tags + saved filters + search e2e', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let idp: TestIdp;
  let ownerToken: string;
  let agentToken: string;
  let viewerToken: string;
  let tenantId: string;
  let projectId: string;
  let widgetKey: string;

  const widgetBase = '/v1/widget/conversations';
  const base = (): string =>
    `/v1/tenants/${tenantId}/projects/${projectId}/conversations`;
  const authOwner = (): { Authorization: string } => ({
    Authorization: `Bearer ${ownerToken}`,
  });
  const authAgent = (): { Authorization: string } => ({
    Authorization: `Bearer ${agentToken}`,
  });
  const authViewer = (): { Authorization: string } => ({
    Authorization: `Bearer ${viewerToken}`,
  });

  // Starts a conversation and posts one visitor message so it has searchable
  // content, then returns its id.
  async function seedConversation(text: string): Promise<string> {
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
      .send({ content: text })
      .expect(201);
    return id;
  }

  beforeAll(async () => {
    ({ container, pool } = await startPg());
    ({ app, idp } = await buildTestApp(pool));
    ownerToken = await idp.sign({ sub: 'oidc|owner', email: 'owner@acme.eu' });
    agentToken = await idp.sign({ sub: 'oidc|agent', email: 'agent@acme.eu' });
    viewerToken = await idp.sign({
      sub: 'oidc|viewer',
      email: 'viewer@acme.eu',
    });

    const t = await request(app.getHttpServer())
      .post('/v1/tenants')
      .set(authOwner())
      .send({ name: 'Acme', slug: 'acme-convsearch' })
      .expect(201);
    tenantId = (t.body as IdBody).id;

    const p = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/projects`)
      .set(authOwner())
      .send({ name: 'Bot', defaultLanguage: 'nl' })
      .expect(201);
    projectId = (p.body as IdBody).id;

    // Register agent + viewer (self-provision on first call), then attach
    // memberships.
    await request(app.getHttpServer())
      .get('/v1/tenants')
      .set(authAgent())
      .expect(200);
    await request(app.getHttpServer())
      .get('/v1/tenants')
      .set(authViewer())
      .expect(200);
    await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/members`)
      .set(authOwner())
      .send({ email: 'agent@acme.eu', role: 'agent' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/members`)
      .set(authOwner())
      .send({ email: 'viewer@acme.eu', role: 'viewer' })
      .expect(201);

    const key = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/api-keys`)
      .set(authOwner())
      .send({ name: 'widget', kind: 'public_widget', projectId })
      .expect(201);
    widgetKey = (key.body as { key: string }).key;
  }, 120000);

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('creates, lists, and deletes conversation tags', async () => {
    const created = await request(app.getHttpServer())
      .post(`${base()}/tags`)
      .set(authAgent())
      .send({ name: 'Urgent', color: '#ff0000' })
      .expect(201);
    const tag = created.body as TagBody;
    expect(tag.name).toBe('Urgent');
    expect(tag.color).toBe('#ff0000');
    expect(tag.projectId).toBe(projectId);

    const list = await request(app.getHttpServer())
      .get(`${base()}/tags`)
      .set(authAgent())
      .expect(200);
    expect((list.body as TagBody[]).some((x) => x.id === tag.id)).toBe(true);

    // Duplicate name (case-insensitive) is rejected by the unique index.
    await request(app.getHttpServer())
      .post(`${base()}/tags`)
      .set(authAgent())
      .send({ name: 'URGENT' })
      .expect(500);

    const del = await request(app.getHttpServer())
      .post(`${base()}/tags`)
      .set(authAgent())
      .send({ name: 'Temp' })
      .expect(201);
    await request(app.getHttpServer())
      .delete(`${base()}/tags/${(del.body as TagBody).id}`)
      .set(authAgent())
      .expect(200);
    await request(app.getHttpServer())
      .delete(`${base()}/tags/${(del.body as TagBody).id}`)
      .set(authAgent())
      .expect(404);
  });

  it('tags/untags a conversation and filters by tag', async () => {
    const convo = await seedConversation('mijn bestelling is nog niet bezorgd');
    const other = await seedConversation('ik wil graag een retour aanvragen');

    const tag = (
      await request(app.getHttpServer())
        .post(`${base()}/tags`)
        .set(authAgent())
        .send({ name: 'Bezorging' })
        .expect(201)
    ).body as TagBody;

    // Idempotent tagging.
    await request(app.getHttpServer())
      .post(`${base()}/${convo}/tags`)
      .set(authAgent())
      .send({ tagId: tag.id })
      .expect(201);
    await request(app.getHttpServer())
      .post(`${base()}/${convo}/tags`)
      .set(authAgent())
      .send({ tagId: tag.id })
      .expect(201);

    const byTag = await request(app.getHttpServer())
      .post(`${base()}/search`)
      .set(authAgent())
      .send({ tagIds: [tag.id] })
      .expect(201);
    const ids = (byTag.body as SearchResult[]).map((r) => r.id);
    expect(ids).toContain(convo);
    expect(ids).not.toContain(other);
    // Tags are hydrated on the result rows.
    const hit = (byTag.body as SearchResult[]).find((r) => r.id === convo);
    expect(hit?.tags.map((x) => x.name)).toContain('Bezorging');

    // Untag removes it from the tag filter.
    await request(app.getHttpServer())
      .delete(`${base()}/${convo}/tags/${tag.id}`)
      .set(authAgent())
      .expect(200);
    const after = await request(app.getHttpServer())
      .post(`${base()}/search`)
      .set(authAgent())
      .send({ tagIds: [tag.id] })
      .expect(201);
    expect((after.body as SearchResult[]).map((r) => r.id)).not.toContain(
      convo,
    );
  });

  it('full-text searches over conversation message content', async () => {
    const refund = await seedConversation(
      'kan ik mijn factuur nog aanpassen na betaling',
    );
    await seedConversation('waar vind ik de openingstijden van de winkel');

    const hits = await request(app.getHttpServer())
      .post(`${base()}/search`)
      .set(authAgent())
      .send({ text: 'factuur' })
      .expect(201);
    const ids = (hits.body as SearchResult[]).map((r) => r.id);
    expect(ids).toContain(refund);

    // A term that appears in neither conversation returns no rows for them.
    const miss = await request(app.getHttpServer())
      .post(`${base()}/search`)
      .set(authAgent())
      .send({ text: 'ruimtevaart' })
      .expect(201);
    expect((miss.body as SearchResult[]).map((r) => r.id)).not.toContain(
      refund,
    );
  });

  it('filters by status and combines with text', async () => {
    // Neutral content that does not trip the frustration auto-escalation
    // heuristic, so the conversation stays in the default 'bot' status.
    const convo = await seedConversation(
      'welke maten heeft dit product beschikbaar',
    );
    const botOnly = await request(app.getHttpServer())
      .post(`${base()}/search`)
      .set(authAgent())
      .send({ status: 'bot', text: 'maten' })
      .expect(201);
    expect((botOnly.body as SearchResult[]).map((r) => r.id)).toContain(convo);

    const closedOnly = await request(app.getHttpServer())
      .post(`${base()}/search`)
      .set(authAgent())
      .send({ status: 'closed', text: 'maten' })
      .expect(201);
    expect((closedOnly.body as SearchResult[]).map((r) => r.id)).not.toContain(
      convo,
    );
  });

  it('saves, lists, reuses, and deletes filter presets (owner-scoped)', async () => {
    const tag = (
      await request(app.getHttpServer())
        .post(`${base()}/tags`)
        .set(authAgent())
        .send({ name: 'Preset' })
        .expect(201)
    ).body as TagBody;

    const saved = await request(app.getHttpServer())
      .post(`${base()}/saved-filters`)
      .set(authAgent())
      .send({
        name: 'My open urgent',
        filter: { status: 'bot', assignee: 'me', tagIds: [tag.id] },
      })
      .expect(201);
    const preset = saved.body as SavedFilterBody;
    expect(preset.name).toBe('My open urgent');
    expect(preset.filter.status).toBe('bot');
    // 'me' is persisted verbatim (resolved only at search time).
    expect(preset.filter.assignee).toBe('me');

    const mine = await request(app.getHttpServer())
      .get(`${base()}/saved-filters`)
      .set(authAgent())
      .expect(200);
    expect(
      (mine.body as SavedFilterBody[]).some((f) => f.id === preset.id),
    ).toBe(true);

    // Saved filters are private to their owner: the viewer sees none of the
    // agent's presets. (Viewer lacks agent role, so this also asserts RBAC.)
    await request(app.getHttpServer())
      .get(`${base()}/saved-filters`)
      .set(authViewer())
      .expect(403);

    await request(app.getHttpServer())
      .delete(`${base()}/saved-filters/${preset.id}`)
      .set(authAgent())
      .expect(200);
    await request(app.getHttpServer())
      .delete(`${base()}/saved-filters/${preset.id}`)
      .set(authAgent())
      .expect(404);
  });

  it('RBAC: viewer cannot tag or search, agent can', async () => {
    await request(app.getHttpServer())
      .post(`${base()}/tags`)
      .set(authViewer())
      .send({ name: 'nope' })
      .expect(403);
    await request(app.getHttpServer())
      .post(`${base()}/search`)
      .set(authViewer())
      .send({ text: 'anything' })
      .expect(403);
    await request(app.getHttpServer())
      .post(`${base()}/search`)
      .set(authAgent())
      .send({ text: 'anything' })
      .expect(201);
  });
});
