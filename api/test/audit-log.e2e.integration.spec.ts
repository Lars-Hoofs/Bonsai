import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPg } from './helpers/pg';
import { buildTestApp } from './helpers/app';
import { TestIdp } from './helpers/oidc';

interface AuditLogItem {
  id: number;
  action: string;
  resource: string;
  actorUserId: string | null;
  actorApiKeyId: string | null;
  metadata: unknown;
  createdAt: string;
}

describe('audit log e2e', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let idp: TestIdp;
  let token: string;
  let tenantId: string;
  let projectId: string;

  beforeAll(async () => {
    ({ container, pool } = await startPg());
    ({ app, idp } = await buildTestApp(pool));
    token = await idp.sign({ sub: 'oidc|admin1', email: 'admin1@acme.eu' });

    const t = await request(app.getHttpServer())
      .post('/v1/tenants')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Audit Tenant', slug: 'audit-t1' })
      .expect(201);
    tenantId = (t.body as { id: string }).id;

    // Auditable action #1: creating a project.
    const p = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/projects`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Support bot' })
      .expect(201);
    projectId = (p.body as { id: string }).id;

    // Auditable action #2: issuing an API key.
    await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/api-keys`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'ci key', kind: 'secret' })
      .expect(201);

    // Auditable action #3: adding a member (also mirrors the viewer user).
    const viewerToken = await idp.sign({
      sub: 'oidc|viewer1',
      email: 'viewer1@acme.eu',
    });
    await request(app.getHttpServer())
      .get('/v1/tenants')
      .set('Authorization', `Bearer ${viewerToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/members`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'viewer1@acme.eu', role: 'viewer' })
      .expect(201);
  });

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('lists the tenant audit log newest-first, filtered by action', async () => {
    const res = await request(app.getHttpServer())
      .get(`/v1/tenants/${tenantId}/audit-log`)
      .set('Authorization', `Bearer ${token}`)
      .query({ action: 'api_key.created' })
      .expect(200);
    const items = res.body as AuditLogItem[];
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.every((i) => i.action === 'api_key.created')).toBe(true);
    expect(items[0].action).toBe('api_key.created');
    expect(items[0].resource).toMatch(/^api_key:/);
    expect(items[0]).not.toHaveProperty('tenantId');
  });

  it('lists all recorded actions newest-first when unfiltered', async () => {
    const res = await request(app.getHttpServer())
      .get(`/v1/tenants/${tenantId}/audit-log`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const items = res.body as AuditLogItem[];
    expect(items.length).toBeGreaterThanOrEqual(3);
    const actions = items.map((i) => i.action);
    expect(actions).toEqual(expect.arrayContaining(['member.added']));
    // newest first
    const timestamps = items.map((i) => new Date(i.createdAt).getTime());
    const sorted = [...timestamps].sort((a, b) => b - a);
    expect(timestamps).toEqual(sorted);
  });

  it('respects limit/offset', async () => {
    const res = await request(app.getHttpServer())
      .get(`/v1/tenants/${tenantId}/audit-log`)
      .set('Authorization', `Bearer ${token}`)
      .query({ limit: 1 })
      .expect(200);
    expect((res.body as AuditLogItem[]).length).toBe(1);
  });

  it('exports as CSV with a header row', async () => {
    const res = await request(app.getHttpServer())
      .get(`/v1/tenants/${tenantId}/audit-log/export`)
      .set('Authorization', `Bearer ${token}`)
      .query({ format: 'csv' })
      .expect(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const lines = res.text.trim().split('\r\n');
    expect(lines[0]).toBe(
      'id,action,resource,actor_user_id,actor_api_key_id,metadata,created_at',
    );
    expect(lines.length).toBeGreaterThan(1);
  });

  it('exports as JSON', async () => {
    const res = await request(app.getHttpServer())
      .get(`/v1/tenants/${tenantId}/audit-log/export`)
      .set('Authorization', `Bearer ${token}`)
      .query({ format: 'json', action: 'member.added' })
      .expect(200);
    expect(res.headers['content-type']).toContain('application/json');
    const items = res.body as AuditLogItem[];
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.every((i) => i.action === 'member.added')).toBe(true);
  });

  it('rejects an invalid export format', async () => {
    await request(app.getHttpServer())
      .get(`/v1/tenants/${tenantId}/audit-log/export`)
      .set('Authorization', `Bearer ${token}`)
      .query({ format: 'xml' })
      .expect(400);
  });

  it('403s for a viewer (below admin)', async () => {
    const viewerToken = await idp.sign({
      sub: 'oidc|viewer1',
      email: 'viewer1@acme.eu',
    });
    await request(app.getHttpServer())
      .get(`/v1/tenants/${tenantId}/audit-log`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .expect(403);
  });

  it('403s for an editor (below admin)', async () => {
    const editorToken = await idp.sign({
      sub: 'oidc|editor1',
      email: 'editor1@acme.eu',
    });
    await request(app.getHttpServer())
      .get('/v1/tenants')
      .set('Authorization', `Bearer ${editorToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/members`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'editor1@acme.eu', role: 'editor' })
      .expect(201);
    await request(app.getHttpServer())
      .get(`/v1/tenants/${tenantId}/audit-log`)
      .set('Authorization', `Bearer ${editorToken}`)
      .expect(403);
  });

  it("does not let a different tenant's admin see this tenant's rows", async () => {
    const otherToken = await idp.sign({
      sub: 'oidc|admin2',
      email: 'admin2@other.eu',
    });
    const t2 = await request(app.getHttpServer())
      .post('/v1/tenants')
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ name: 'Other Tenant', slug: 'audit-t2' })
      .expect(201);
    const otherTenantId = (t2.body as { id: string }).id;

    // Admin of tenant 2 cannot query tenant 1's audit log at all.
    await request(app.getHttpServer())
      .get(`/v1/tenants/${tenantId}/audit-log`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(403);

    // And tenant 2's own (empty) audit log never contains tenant 1's rows.
    const res = await request(app.getHttpServer())
      .get(`/v1/tenants/${otherTenantId}/audit-log`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(200);
    const items = res.body as AuditLogItem[];
    expect(items.some((i) => i.resource.includes(projectId))).toBe(false);
  });
});
