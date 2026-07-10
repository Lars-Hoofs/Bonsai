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
interface ReplyBody {
  status: string;
  moderation?: { action: 'warn' | 'block' | 'flag' };
  reply?: { content: string; refused: boolean };
}
interface ModerationEvent {
  id: string;
  conversationId: string | null;
  action: string;
  matchedTerms: string[];
  content: string;
}

/**
 * Profanity/abuse filter on visitor input e2e (#31). One Nest app + one
 * Postgres container; each test opts a fresh project into a specific policy
 * (warn/block/flag) via the project settings API, then drives the public
 * widget flow and asserts the policy is applied before the answer pipeline
 * and that a moderation event is recorded.
 */
describe('profanity/abuse filter e2e', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let idp: TestIdp;
  let token: string;
  let tenantId: string;
  let widgetKey: string;

  const widgetBase = '/v1/widget/conversations';
  const auth = (): { Authorization: string } => ({
    Authorization: `Bearer ${token}`,
  });

  beforeAll(async () => {
    ({ container, pool } = await startPg());
    ({ app, idp } = await buildTestApp(pool));
    token = await idp.sign({ sub: 'oidc|mod', email: 'mod@acme.eu' });
    const t = await request(app.getHttpServer())
      .post('/v1/tenants')
      .set(auth())
      .send({ name: 'ModAcme', slug: 'mod-acme' })
      .expect(201);
    tenantId = (t.body as IdBody).id;
  }, 120000);

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  async function makeProject(
    policy: { enabled: boolean; action: 'warn' | 'block' | 'flag' } | null,
  ): Promise<string> {
    const p = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/projects`)
      .set(auth())
      .send({ name: 'Bot' })
      .expect(201);
    const projectId = (p.body as IdBody).id;
    // Seed KB so a clean question can actually be answered (flag path).
    await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/projects/${projectId}/knowledge/sources`)
      .set(auth())
      .send({
        type: 'manual',
        name: 'Openingstijden',
        config: {
          title: 'Openingstijden',
          body: 'De openingstijden zijn maandag tot en met vrijdag van negen tot vijf uur.',
        },
      })
      .expect(201);
    if (policy) {
      await request(app.getHttpServer())
        .patch(`/v1/tenants/${tenantId}/projects/${projectId}/settings`)
        .set(auth())
        .send({ profanityFilter: policy })
        .expect(200);
    }
    return projectId;
  }

  async function startConversation(): Promise<StartBody> {
    const started = await request(app.getHttpServer())
      .post(widgetBase)
      .set('x-bonsai-key', widgetKey)
      .send({ language: 'nl' })
      .expect(201);
    return started.body as StartBody;
  }

  function postMessage(
    conversationId: string,
    visitorSecret: string,
    content: string,
  ): request.Test {
    return request(app.getHttpServer())
      .post(`${widgetBase}/${conversationId}/messages`)
      .set('x-bonsai-key', widgetKey)
      .set('x-bonsai-visitor-secret', visitorSecret)
      .send({ content });
  }

  async function newWidgetKey(projectId: string): Promise<void> {
    const key = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/api-keys`)
      .set(auth())
      .send({ name: 'widget', kind: 'public_widget', projectId })
      .expect(201);
    widgetKey = (key.body as { key: string }).key;
  }

  async function listEvents(projectId: string): Promise<ModerationEvent[]> {
    const res = await request(app.getHttpServer())
      .get(`/v1/tenants/${tenantId}/projects/${projectId}/moderation/events`)
      .set(auth())
      .expect(200);
    return res.body as ModerationEvent[];
  }

  it('block: does not answer, returns a system warning, records the event', async () => {
    const projectId = await makeProject({ enabled: true, action: 'block' });
    await newWidgetKey(projectId);
    const { id, visitorSecret } = await startConversation();

    const res = await postMessage(
      id,
      visitorSecret,
      'you are a piece of shit',
    ).expect(201);
    const body = res.body as ReplyBody;
    expect(body.status).toBe('bot');
    expect(body.moderation?.action).toBe('block');
    // Answer pipeline was skipped entirely.
    expect(body.reply).toBeUndefined();

    const events = await listEvents(projectId);
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('block');
    expect(events[0].conversationId).toBe(id);
    expect(events[0].matchedTerms).toContain('shit');
  });

  it('warn: does not answer, returns a warning, records the event', async () => {
    const projectId = await makeProject({ enabled: true, action: 'warn' });
    await newWidgetKey(projectId);
    const { id, visitorSecret } = await startConversation();

    const res = await postMessage(id, visitorSecret, 'wat een kut bot').expect(
      201,
    );
    const body = res.body as ReplyBody;
    expect(body.moderation?.action).toBe('warn');
    expect(body.reply).toBeUndefined();

    const events = await listEvents(projectId);
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('warn');
  });

  it('flag: still answers normally, but records the event', async () => {
    const projectId = await makeProject({ enabled: true, action: 'flag' });
    await newWidgetKey(projectId);
    const { id, visitorSecret } = await startConversation();

    const res = await postMessage(
      id,
      visitorSecret,
      'wat zijn de openingstijden, shit',
    ).expect(201);
    const body = res.body as ReplyBody;
    expect(body.moderation?.action).toBe('flag');
    // Flag does NOT short-circuit — the bot still answers.
    expect(body.reply).toBeDefined();

    const events = await listEvents(projectId);
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('flag');
  });

  it('clean message: no event, normal answer, no moderation field', async () => {
    const projectId = await makeProject({ enabled: true, action: 'block' });
    await newWidgetKey(projectId);
    const { id, visitorSecret } = await startConversation();

    const res = await postMessage(
      id,
      visitorSecret,
      'wat zijn de openingstijden',
    ).expect(201);
    const body = res.body as ReplyBody;
    expect(body.moderation).toBeUndefined();
    expect(body.reply).toBeDefined();

    expect(await listEvents(projectId)).toHaveLength(0);
  });

  it('disabled (project not opted in): profanity is answered, no event', async () => {
    const projectId = await makeProject(null);
    await newWidgetKey(projectId);
    const { id, visitorSecret } = await startConversation();

    const res = await postMessage(id, visitorSecret, 'this shit again').expect(
      201,
    );
    const body = res.body as ReplyBody;
    expect(body.moderation).toBeUndefined();
    expect(body.reply).toBeDefined();

    expect(await listEvents(projectId)).toHaveLength(0);
  });
});
