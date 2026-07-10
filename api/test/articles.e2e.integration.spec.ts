import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPg } from './helpers/pg';
import { buildTestApp } from './helpers/app';
import { TestIdp } from './helpers/oidc';

interface ArticleBody {
  id: string;
  type: string;
  status: string;
  title: string;
  question: string | null;
  answer: string | null;
  body: string;
  categories: string[];
  tags: string[];
}
interface DocListItem {
  id: string;
  title: string;
  chunkCount: number;
}

describe('manual Q&A / article editor e2e', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let idp: TestIdp;
  let ownerToken: string;
  let viewerToken: string;
  let tenantId: string;
  let projectId: string;

  const knowledge = (): string =>
    `/v1/tenants/${tenantId}/projects/${projectId}/knowledge`;
  const base = (): string => `${knowledge()}/articles`;
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
      .send({ name: 'Acme', slug: 'acme-articles' })
      .expect(201);
    tenantId = (t.body as { id: string }).id;

    const p = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/projects`)
      .set(authOwner())
      .send({ name: 'Bot', defaultLanguage: 'nl' })
      .expect(201);
    projectId = (p.body as { id: string }).id;

    // Register the viewer then attach a viewer membership.
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

  it('creates an article from rich-text (html) and ingests it into chunks', async () => {
    const res = await request(app.getHttpServer())
      .post(base())
      .set(authOwner())
      .send({
        title: 'Retourbeleid',
        contentFormat: 'html',
        content:
          '<h2>Retourbeleid</h2><p>Je kunt binnen <strong>14 dagen</strong> retourneren.</p><ul><li>Ongebruikt</li><li>Met bon</li></ul>',
        categories: ['Verkoop'],
        tags: ['retour', 'faq'],
      })
      .expect(201);

    const article = res.body as ArticleBody;
    expect(article.type).toBe('article');
    expect(article.status).toBe('processed');
    expect(article.body).toContain('**14 dagen**');
    expect(article.body).not.toMatch(/<[^>]+>/); // converted to markdown
    expect(article.categories).toEqual(['Verkoop']);
    expect(article.tags).toEqual(['retour', 'faq']);

    // Became a first-class knowledge source: appears among documents/chunks.
    const docs = await request(app.getHttpServer())
      .get(`${knowledge()}/documents?sourceId=${article.id}`)
      .set(authOwner())
      .expect(200);
    const docList = docs.body as DocListItem[];
    expect(docList).toHaveLength(1);
    expect(docList[0].chunkCount).toBeGreaterThan(0);

    // Shows up in the generic knowledge sources listing too.
    const sources = await request(app.getHttpServer())
      .get(`${knowledge()}/sources`)
      .set(authOwner())
      .expect(200);
    expect(
      (sources.body as { id: string; type: string }[]).some(
        (s) => s.id === article.id && s.type === 'article',
      ),
    ).toBe(true);
  });

  it('creates a Q&A pair embedding both question and answer', async () => {
    const res = await request(app.getHttpServer())
      .post(base())
      .set(authOwner())
      .send({
        title: 'Verzendkosten',
        question: 'Wat kost verzending?',
        answer: 'Verzending is gratis boven 50 euro.',
      })
      .expect(201);
    const article = res.body as ArticleBody;
    expect(article.question).toBe('Wat kost verzending?');
    expect(article.answer).toBe('Verzending is gratis boven 50 euro.');
    expect(article.body).toContain('## Wat kost verzending?');
    expect(article.body).toContain('gratis boven 50 euro');
  });

  it('lists and fetches a single article', async () => {
    const created = await request(app.getHttpServer())
      .post(base())
      .set(authOwner())
      .send({ title: 'Ophalen', content: '<p>inhoud</p>' })
      .expect(201);
    const id = (created.body as ArticleBody).id;

    const list = await request(app.getHttpServer())
      .get(base())
      .set(authOwner())
      .expect(200);
    expect((list.body as ArticleBody[]).some((a) => a.id === id)).toBe(true);

    const one = await request(app.getHttpServer())
      .get(`${base()}/${id}`)
      .set(authOwner())
      .expect(200);
    expect((one.body as ArticleBody).title).toBe('Ophalen');
  });

  it('edits an article and re-ingests the new content', async () => {
    const created = await request(app.getHttpServer())
      .post(base())
      .set(authOwner())
      .send({ title: 'Origineel', content: '<p>oude inhoud</p>' })
      .expect(201);
    const id = (created.body as ArticleBody).id;

    const updated = await request(app.getHttpServer())
      .put(`${base()}/${id}`)
      .set(authOwner())
      .send({
        title: 'Bijgewerkt',
        content: '<p>nieuwe <strong>inhoud</strong></p>',
        tags: ['bijgewerkt'],
      })
      .expect(200);
    const article = updated.body as ArticleBody;
    expect(article.title).toBe('Bijgewerkt');
    expect(article.status).toBe('processed');
    expect(article.body).toContain('nieuwe **inhoud**');
    expect(article.tags).toEqual(['bijgewerkt']);

    const docs = await request(app.getHttpServer())
      .get(`${knowledge()}/documents?sourceId=${id}`)
      .set(authOwner())
      .expect(200);
    const docList = docs.body as DocListItem[];
    expect(docList).toHaveLength(1);
    expect(docList[0].title).toBe('Bijgewerkt');
  });

  it('deletes an article (admin) and removes it from the knowledge base', async () => {
    const created = await request(app.getHttpServer())
      .post(base())
      .set(authOwner())
      .send({ title: 'TeVerwijderen', content: '<p>x</p>' })
      .expect(201);
    const id = (created.body as ArticleBody).id;

    await request(app.getHttpServer())
      .delete(`${base()}/${id}`)
      .set(authOwner())
      .expect(200);

    await request(app.getHttpServer())
      .get(`${base()}/${id}`)
      .set(authOwner())
      .expect(404);
  });

  it('RBAC: viewer can list/read but cannot create, edit, or delete', async () => {
    await request(app.getHttpServer())
      .get(base())
      .set(authViewer())
      .expect(200);

    await request(app.getHttpServer())
      .post(base())
      .set(authViewer())
      .send({ title: 'Blocked', content: '<p>x</p>' })
      .expect(403);

    const created = await request(app.getHttpServer())
      .post(base())
      .set(authOwner())
      .send({ title: 'OwnerOnly', content: '<p>x</p>' })
      .expect(201);
    const id = (created.body as ArticleBody).id;

    await request(app.getHttpServer())
      .put(`${base()}/${id}`)
      .set(authViewer())
      .send({ title: 'Nope', content: '<p>y</p>' })
      .expect(403);

    await request(app.getHttpServer())
      .delete(`${base()}/${id}`)
      .set(authViewer())
      .expect(403);
  });

  it('writes audit rows for article create/update/delete', async () => {
    const created = await request(app.getHttpServer())
      .post(base())
      .set(authOwner())
      .send({ title: 'Audited', content: '<p>x</p>' })
      .expect(201);
    const id = (created.body as ArticleBody).id;

    await request(app.getHttpServer())
      .put(`${base()}/${id}`)
      .set(authOwner())
      .send({ title: 'Audited2', content: '<p>y</p>' })
      .expect(200);

    await request(app.getHttpServer())
      .delete(`${base()}/${id}`)
      .set(authOwner())
      .expect(200);

    const audit = await pool.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE resource = $1 ORDER BY created_at`,
      [`knowledge_source:${id}`],
    );
    const actions = audit.rows.map((r) => r.action);
    expect(actions).toContain('knowledge_source.created');
    expect(actions).toContain('knowledge_article.updated');
    expect(actions).toContain('knowledge_source.deleted');
  });
});
