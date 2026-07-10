import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Pool } from 'pg';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startPg } from './helpers/pg';
import { buildTestApp } from './helpers/app';

interface IdBody {
  id: string;
}
interface StartBody {
  id: string;
  visitorSecret: string;
}
interface ReplyBody {
  status: string;
  reply?: {
    content: string;
    refused: boolean;
    escalationSuggested: boolean;
    autoEscalated: boolean;
  };
}
interface ConvoView {
  conversation: { status: string };
}

/**
 * Frustration/sentiment auto-escalation e2e (#24). Each `describe` block
 * spins up its own Nest app *and its own `pg.Pool`* against one shared
 * Postgres container (to keep this fast), with the config variant it needs
 * (`frustrationRefusalStreak` / `frustrationAutoEscalateEnabled`), since
 * `buildTestApp` bakes config in at app-build time. A separate pool per app
 * is required, not just a separate app: `app.close()` runs `DbModule`'s
 * `onModuleDestroy`, which calls `pool.end()` on whatever pool that app was
 * given — sharing one pool across apps would leave every other app's pool
 * unusable as soon as the first app closes.
 */
describe('frustration auto-escalation e2e', () => {
  let container: StartedPostgreSqlContainer;

  const widgetBase = '/v1/widget/conversations';

  beforeAll(async () => {
    ({ container } = await startPg());
  }, 120000);

  afterAll(async () => {
    await container.stop();
  });

  /**
   * Each app returned by `buildTestApp` has its own OIDC test IdP (bound via
   * `JWT_KEY_GETTER` override), so the auth token must be minted against
   * *that* app's `idp`, not shared across apps.
   */
  async function setupTenantAndWidgetKey(
    app: INestApplication,
    idp: { sign: (claims: { sub: string; email: string }) => Promise<string> },
    slugSuffix: string,
  ): Promise<{ tenantId: string; projectId: string; widgetKey: string }> {
    const token = await idp.sign({
      sub: `oidc|frustration-${slugSuffix}`,
      email: `f-${slugSuffix}@acme.eu`,
    });
    const auth = { Authorization: `Bearer ${token}` };
    const t = await request(app.getHttpServer())
      .post('/v1/tenants')
      .set(auth)
      .send({ name: `Frust${slugSuffix}`, slug: `frust-${slugSuffix}` })
      .expect(201);
    const tenantId = (t.body as IdBody).id;
    const p = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/projects`)
      .set(auth)
      .send({ name: 'Bot' })
      .expect(201);
    const projectId = (p.body as IdBody).id;
    // Seed knowledge so a "known" question can be answered, and a
    // clearly-unrelated question reliably refuses.
    await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/projects/${projectId}/knowledge/sources`)
      .set(auth)
      .send({
        type: 'manual',
        name: 'Openingstijden',
        config: {
          title: 'Openingstijden',
          body: 'De openingstijden van onze winkel zijn maandag tot en met vrijdag van negen tot vijf uur.',
        },
      })
      .expect(201);
    const key = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/api-keys`)
      .set(auth)
      .send({ name: 'widget', kind: 'public_widget', projectId })
      .expect(201);
    const widgetKey = (key.body as { key: string }).key;
    return { tenantId, projectId, widgetKey };
  }

  async function startConversation(
    app: INestApplication,
    widgetKey: string,
  ): Promise<StartBody> {
    const started = await request(app.getHttpServer())
      .post(widgetBase)
      .set('x-bonsai-key', widgetKey)
      .send({ language: 'nl' })
      .expect(201);
    return started.body as StartBody;
  }

  function postMessage(
    app: INestApplication,
    widgetKey: string,
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

  async function conversationStatus(
    app: INestApplication,
    widgetKey: string,
    conversationId: string,
    visitorSecret: string,
  ): Promise<string> {
    const res = await request(app.getHttpServer())
      .get(`${widgetBase}/${conversationId}`)
      .set('x-bonsai-key', widgetKey)
      .set('x-bonsai-visitor-secret', visitorSecret)
      .expect(200);
    return (res.body as ConvoView).conversation.status;
  }

  const OUT_OF_KB_QUESTION =
    'hoe werkt kwantumverstrengeling in de ruimtevaart';

  describe('enabled (default), refusal streak = 2', () => {
    let pool: Pool;
    let app: INestApplication;
    let idp: Awaited<ReturnType<typeof buildTestApp>>['idp'];

    beforeAll(async () => {
      pool = new Pool({ connectionString: container.getConnectionUri() });
      ({ app, idp } = await buildTestApp(pool, {
        frustrationAutoEscalateEnabled: true,
        frustrationRefusalStreak: 2,
      }));
    }, 120000);

    afterAll(async () => {
      await app.close();
    });

    it('does NOT auto-escalate after a single out-of-KB refusal', async () => {
      const { widgetKey } = await setupTenantAndWidgetKey(app, idp, 'streak-a');
      const { id: conversationId, visitorSecret } = await startConversation(
        app,
        widgetKey,
      );

      const first = await postMessage(
        app,
        widgetKey,
        conversationId,
        visitorSecret,
        OUT_OF_KB_QUESTION,
      ).expect(201);
      const firstBody = first.body as ReplyBody;
      expect(firstBody.reply?.refused).toBe(true);
      expect(firstBody.reply?.autoEscalated).toBe(false);
      expect(firstBody.status).toBe('bot');

      const status = await conversationStatus(
        app,
        widgetKey,
        conversationId,
        visitorSecret,
      );
      expect(status).toBe('bot');
    });

    it('auto-escalates on the 2nd consecutive out-of-KB refusal', async () => {
      const { widgetKey } = await setupTenantAndWidgetKey(app, idp, 'streak-b');
      const { id: conversationId, visitorSecret } = await startConversation(
        app,
        widgetKey,
      );

      await postMessage(
        app,
        widgetKey,
        conversationId,
        visitorSecret,
        OUT_OF_KB_QUESTION,
      ).expect(201);

      // Same out-of-KB question again: refusals aren't cached (only
      // non-refused answers are, per AnswerService), so this reliably
      // refuses a second time with the deterministic fake embedding/LLM,
      // completing the 2-in-a-row refusal streak.
      const second = await postMessage(
        app,
        widgetKey,
        conversationId,
        visitorSecret,
        OUT_OF_KB_QUESTION,
      ).expect(201);
      const secondBody = second.body as ReplyBody;
      expect(secondBody.reply?.refused).toBe(true);
      expect(secondBody.reply?.autoEscalated).toBe(true);
      expect(secondBody.status).toBe('handover');

      const status = await conversationStatus(
        app,
        widgetKey,
        conversationId,
        visitorSecret,
      );
      expect(status).toBe('handover');
    });

    it('auto-escalates immediately on an explicit human request, even without a refusal', async () => {
      const { widgetKey } = await setupTenantAndWidgetKey(app, idp, 'explicit');
      const { id: conversationId, visitorSecret } = await startConversation(
        app,
        widgetKey,
      );

      const res = await postMessage(
        app,
        widgetKey,
        conversationId,
        visitorSecret,
        'ik wil een medewerker',
      ).expect(201);
      const body = res.body as ReplyBody;
      expect(body.reply?.autoEscalated).toBe(true);
      expect(body.status).toBe('handover');

      const status = await conversationStatus(
        app,
        widgetKey,
        conversationId,
        visitorSecret,
      );
      expect(status).toBe('handover');
    });

    it('auto-escalates immediately on clearly negative sentiment', async () => {
      const { widgetKey } = await setupTenantAndWidgetKey(app, idp, 'negative');
      const { id: conversationId, visitorSecret } = await startConversation(
        app,
        widgetKey,
      );

      const res = await postMessage(
        app,
        widgetKey,
        conversationId,
        visitorSecret,
        'dit is echt belachelijk en waardeloos',
      ).expect(201);
      const body = res.body as ReplyBody;
      expect(body.reply?.autoEscalated).toBe(true);
      expect(body.status).toBe('handover');

      const status = await conversationStatus(
        app,
        widgetKey,
        conversationId,
        visitorSecret,
      );
      expect(status).toBe('handover');
    });

    it('does not double-escalate an already-handover conversation', async () => {
      const { widgetKey } = await setupTenantAndWidgetKey(app, idp, 'double');
      const { id: conversationId, visitorSecret } = await startConversation(
        app,
        widgetKey,
      );

      await postMessage(
        app,
        widgetKey,
        conversationId,
        visitorSecret,
        'ik wil een medewerker',
      ).expect(201);

      // Second message, already in handover: must not attempt to re-escalate
      // or blow up, and must not produce a bot reply.
      const during = await postMessage(
        app,
        widgetKey,
        conversationId,
        visitorSecret,
        'dank je',
      ).expect(201);
      const duringBody = during.body as ReplyBody;
      expect(duringBody.status).toBe('handover');
      expect(duringBody.reply).toBeUndefined();
    });

    it('does not auto-escalate on a neutral, in-KB question', async () => {
      const { widgetKey } = await setupTenantAndWidgetKey(app, idp, 'neutral');
      const { id: conversationId, visitorSecret } = await startConversation(
        app,
        widgetKey,
      );

      const res = await postMessage(
        app,
        widgetKey,
        conversationId,
        visitorSecret,
        'wat zijn de openingstijden',
      ).expect(201);
      const body = res.body as ReplyBody;
      expect(body.reply?.refused).toBe(false);
      expect(body.reply?.autoEscalated).toBe(false);
      expect(body.status).toBe('bot');
    });
  });

  describe('disabled (FRUSTRATION_AUTO_ESCALATE_ENABLED=false)', () => {
    let pool: Pool;
    let app: INestApplication;
    let idp: Awaited<ReturnType<typeof buildTestApp>>['idp'];

    beforeAll(async () => {
      pool = new Pool({ connectionString: container.getConnectionUri() });
      ({ app, idp } = await buildTestApp(pool, {
        frustrationAutoEscalateEnabled: false,
        frustrationRefusalStreak: 2,
      }));
    }, 120000);

    afterAll(async () => {
      await app.close();
    });

    it('does not auto-escalate on a refusal streak when disabled', async () => {
      const { widgetKey } = await setupTenantAndWidgetKey(
        app,
        idp,
        'off-streak',
      );
      const { id: conversationId, visitorSecret } = await startConversation(
        app,
        widgetKey,
      );

      await postMessage(
        app,
        widgetKey,
        conversationId,
        visitorSecret,
        OUT_OF_KB_QUESTION,
      ).expect(201);
      const second = await postMessage(
        app,
        widgetKey,
        conversationId,
        visitorSecret,
        OUT_OF_KB_QUESTION,
      ).expect(201);
      expect((second.body as ReplyBody).reply?.autoEscalated).toBe(false);
      expect((second.body as ReplyBody).status).toBe('bot');
    });

    it('does not auto-escalate on an explicit human request when disabled', async () => {
      const { widgetKey } = await setupTenantAndWidgetKey(
        app,
        idp,
        'off-explicit',
      );
      const { id: conversationId, visitorSecret } = await startConversation(
        app,
        widgetKey,
      );

      const res = await postMessage(
        app,
        widgetKey,
        conversationId,
        visitorSecret,
        'ik wil een medewerker',
      ).expect(201);
      expect((res.body as ReplyBody).reply?.autoEscalated).toBe(false);
      expect((res.body as ReplyBody).status).toBe('bot');
    });

    it('does not auto-escalate on negative sentiment when disabled', async () => {
      const { widgetKey } = await setupTenantAndWidgetKey(
        app,
        idp,
        'off-negative',
      );
      const { id: conversationId, visitorSecret } = await startConversation(
        app,
        widgetKey,
      );

      const res = await postMessage(
        app,
        widgetKey,
        conversationId,
        visitorSecret,
        'dit is echt belachelijk en waardeloos',
      ).expect(201);
      expect((res.body as ReplyBody).reply?.autoEscalated).toBe(false);
      expect((res.body as ReplyBody).status).toBe('bot');
    });
  });
});
