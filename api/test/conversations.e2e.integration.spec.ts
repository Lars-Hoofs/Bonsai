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
interface ReplyBody {
  status: string;
  reply?: {
    content: string;
    refused: boolean;
    escalationSuggested: boolean;
    citations: { documentTitle: string }[];
  };
}
interface ConvoView {
  conversation: { status: string };
  messages: { role: string; content: string }[];
}
interface StartBody {
  id: string;
  visitorSecret: string;
}
interface EscalateBody {
  ok: true;
  afterHours: boolean;
}

describe('conversations + handover e2e', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let idp: TestIdp;
  let token: string;
  let tenantId: string;
  let projectId: string;
  let widgetKey: string;

  const agentBase = (): string =>
    `/v1/tenants/${tenantId}/projects/${projectId}/conversations`;
  const widgetBase = '/v1/widget/conversations';
  const auth = (): { Authorization: string } => ({
    Authorization: `Bearer ${token}`,
  });

  beforeAll(async () => {
    ({ container, pool } = await startPg());
    ({ app, idp } = await buildTestApp(pool));
    token = await idp.sign({ sub: 'oidc|u1', email: 'u1@acme.eu' });
    const t = await request(app.getHttpServer())
      .post('/v1/tenants')
      .set(auth())
      .send({ name: 'Acme', slug: 'acme' })
      .expect(201);
    tenantId = (t.body as IdBody).id;
    const p = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/projects`)
      .set(auth())
      .send({ name: 'Bot' })
      .expect(201);
    projectId = (p.body as IdBody).id;
    // Seed knowledge so the bot can answer at least one thing.
    await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/projects/${projectId}/knowledge/sources`)
      .set(auth())
      .send({
        type: 'manual',
        name: 'Openingstijden',
        config: {
          title: 'Openingstijden',
          body: 'De openingstijden van onze winkel zijn maandag tot en met vrijdag van negen tot vijf uur.',
        },
      })
      .expect(201);

    // Issue a public_widget key bound to this project (mirrors the widget's
    // real onboarding flow, same as test/widget-public.e2e.integration.spec.ts).
    const key = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/api-keys`)
      .set(auth())
      .send({ name: 'widget', kind: 'public_widget', projectId })
      .expect(201);
    widgetKey = (key.body as { key: string }).key;
  }, 120000);

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('runs a full bot -> escalate -> agent -> return-to-bot lifecycle', async () => {
    const started = await request(app.getHttpServer())
      .post(widgetBase)
      .set('x-bonsai-key', widgetKey)
      .send({ language: 'nl' })
      .expect(201);
    const { id: conversationId, visitorSecret } = started.body as StartBody;
    expect(conversationId).toBeDefined();
    expect(visitorSecret).toBeDefined();

    // Bot can answer a question that's actually in the seeded KB.
    const known = await request(app.getHttpServer())
      .post(`${widgetBase}/${conversationId}/messages`)
      .set('x-bonsai-key', widgetKey)
      .set('x-bonsai-visitor-secret', visitorSecret)
      .send({ content: 'wat zijn de openingstijden' })
      .expect(201);
    const knownBody = known.body as ReplyBody;
    expect(knownBody.status).toBe('bot');
    expect(knownBody.reply?.refused).toBe(false);
    expect(knownBody.reply?.citations.length).toBeGreaterThan(0);

    // The stored bot message must persist its citations to
    // message_citations (same transaction as the message insert), so a
    // stored answer always carries its sources, not just the API response.
    const tenantRow = await pool.query<{ schema_name: string }>(
      'SELECT schema_name FROM tenants WHERE id = $1',
      [tenantId],
    );
    const tenantSchema = tenantRow.rows[0].schema_name;
    const citationRows = await pool.query<{
      chunk_id: string;
      document_id: string;
      document_title: string;
    }>(
      `SELECT mc.chunk_id, mc.document_id, mc.document_title
         FROM "${tenantSchema}".message_citations mc
         JOIN "${tenantSchema}".messages m ON m.id = mc.message_id
        WHERE m.conversation_id = $1 AND m.role = 'bot'`,
      [conversationId],
    );
    expect(citationRows.rows.length).toBeGreaterThan(0);
    expect(citationRows.rows[0].document_title).toBe('Openingstijden');

    // Out-of-KB question -> refusal + escalation suggested.
    const unknown = await request(app.getHttpServer())
      .post(`${widgetBase}/${conversationId}/messages`)
      .set('x-bonsai-key', widgetKey)
      .set('x-bonsai-visitor-secret', visitorSecret)
      .send({ content: 'hoe werkt kwantumverstrengeling in de ruimtevaart' })
      .expect(201);
    const unknownBody = unknown.body as ReplyBody;
    expect(unknownBody.status).toBe('bot');
    expect(unknownBody.reply?.refused).toBe(true);
    expect(unknownBody.reply?.escalationSuggested).toBe(true);

    // Escalate to a human, as the visitor. No businessHours configured on
    // this project, so escalation must behave exactly as before A1:
    // afterHours=false, and (asserted below via the system message in the
    // agent view) the live-agent handover message is posted.
    const escalated = await request(app.getHttpServer())
      .post(`${widgetBase}/${conversationId}/escalate`)
      .set('x-bonsai-key', widgetKey)
      .set('x-bonsai-visitor-secret', visitorSecret)
      .send({ reason: 'frustration' })
      .expect(201);
    expect((escalated.body as EscalateBody).afterHours).toBe(false);

    // Conversation now shows up in the agent inbox.
    const inbox = await request(app.getHttpServer())
      .get(`${agentBase()}?status=handover`)
      .set(auth())
      .expect(200);
    expect((inbox.body as IdBody[]).map((c) => c.id)).toContain(conversationId);

    // Agent replies.
    await request(app.getHttpServer())
      .post(`${agentBase()}/${conversationId}/agent-messages`)
      .set(auth())
      .send({ content: 'Hoi, ik help je verder!' })
      .expect(201);

    // A visitor message during handover is stored but not auto-answered.
    const during = await request(app.getHttpServer())
      .post(`${widgetBase}/${conversationId}/messages`)
      .set('x-bonsai-key', widgetKey)
      .set('x-bonsai-visitor-secret', visitorSecret)
      .send({ content: 'dank je' })
      .expect(201);
    expect((during.body as ReplyBody).status).toBe('handover');
    expect((during.body as ReplyBody).reply).toBeUndefined();

    // Return to bot (agent action).
    await request(app.getHttpServer())
      .post(`${agentBase()}/${conversationId}/return-to-bot`)
      .set(auth())
      .expect(201);

    // Agent view of the conversation.
    const view = await request(app.getHttpServer())
      .get(`${agentBase()}/${conversationId}`)
      .set(auth())
      .expect(200);
    const v = view.body as ConvoView;
    expect(v.conversation.status).toBe('bot');
    expect(v.messages.some((m) => m.role === 'agent')).toBe(true);
    expect(v.messages.some((m) => m.role === 'system')).toBe(true);
    // In-hours (no schedule configured) escalation posts the live-agent
    // message, not the after-hours contact-form message.
    expect(
      v.messages.some(
        (m) =>
          m.role === 'system' &&
          m.content === 'Gesprek doorgezet naar een medewerker.',
      ),
    ).toBe(true);

    // Visitor can also reload their own history via the public endpoint, and
    // it must not include a visitorSecret field (only `start` returns one).
    const visitorView = await request(app.getHttpServer())
      .get(`${widgetBase}/${conversationId}`)
      .set('x-bonsai-key', widgetKey)
      .set('x-bonsai-visitor-secret', visitorSecret)
      .expect(200);
    const vv = visitorView.body as ConvoView & {
      conversation: { visitorSecret?: string };
    };
    expect(vv.conversation.status).toBe('bot');
    expect(vv.conversation.visitorSecret).toBeUndefined();
  });

  it('escalates as after-hours when the project has a businessHours schedule that is always closed', async () => {
    // Separate project so this schedule doesn't affect the lifecycle test
    // above (which relies on no businessHours being configured -> afterHours
    // false, in-hours message).
    const p = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/projects`)
      .set(auth())
      .send({ name: 'AfterHoursBot' })
      .expect(201);
    const ahProjectId = (p.body as IdBody).id;

    const key = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/api-keys`)
      .set(auth())
      .send({
        name: 'widget-ah',
        kind: 'public_widget',
        projectId: ahProjectId,
      })
      .expect(201);
    const ahWidgetKey = (key.body as { key: string }).key;

    // Zero-width interval (open === close) for every ISO weekday (1-7) is
    // deterministically "always closed" regardless of the real wall-clock
    // time the test suite happens to run at — see business-hours.ts's
    // half-open [open, close) semantics.
    const tenantRow = await pool.query<{ schema_name: string }>(
      'SELECT schema_name FROM tenants WHERE id = $1',
      [tenantId],
    );
    const tenantSchema = tenantRow.rows[0].schema_name;
    const alwaysClosedSchedule = {
      timezone: 'Europe/Amsterdam',
      intervals: [1, 2, 3, 4, 5, 6, 7].map((day) => ({
        day,
        open: '00:00',
        close: '00:00',
      })),
    };
    await pool.query(
      `UPDATE "${tenantSchema}".projects
         SET settings = jsonb_set(settings, '{businessHours}', $1::jsonb)
       WHERE id = $2`,
      [JSON.stringify(alwaysClosedSchedule), ahProjectId],
    );

    const started = await request(app.getHttpServer())
      .post(widgetBase)
      .set('x-bonsai-key', ahWidgetKey)
      .send({ language: 'nl' })
      .expect(201);
    const { id: conversationId, visitorSecret } = started.body as StartBody;

    const escalated = await request(app.getHttpServer())
      .post(`${widgetBase}/${conversationId}/escalate`)
      .set('x-bonsai-key', ahWidgetKey)
      .set('x-bonsai-visitor-secret', visitorSecret)
      .send({ reason: 'visitor_request' })
      .expect(201);
    expect((escalated.body as EscalateBody).afterHours).toBe(true);

    // The conversation still lands in handover (agent inbox), unchanged.
    const inbox = await request(app.getHttpServer())
      .get(
        `/v1/tenants/${tenantId}/projects/${ahProjectId}/conversations?status=handover`,
      )
      .set(auth())
      .expect(200);
    expect((inbox.body as IdBody[]).map((c) => c.id)).toContain(conversationId);

    // The posted bot message is the after-hours contact-form message, not
    // the in-hours "connecting you to an agent" message.
    const view = await request(app.getHttpServer())
      .get(
        `/v1/tenants/${tenantId}/projects/${ahProjectId}/conversations/${conversationId}`,
      )
      .set(auth())
      .expect(200);
    const v = view.body as ConvoView;
    expect(
      v.messages.some(
        (m) =>
          m.role === 'system' &&
          m.content ===
            'Onze medewerkers zijn nu niet bereikbaar. Laat je e-mailadres achter, dan nemen we zo snel mogelijk contact met je op.',
      ),
    ).toBe(true);
    expect(
      v.messages.some(
        (m) =>
          m.role === 'system' &&
          m.content === 'Gesprek doorgezet naar een medewerker.',
      ),
    ).toBe(false);

    // Re-escalating an already-in-handover conversation is idempotent but
    // still reports afterHours based on the current schedule/time.
    const reEscalated = await request(app.getHttpServer())
      .post(`${widgetBase}/${conversationId}/escalate`)
      .set('x-bonsai-key', ahWidgetKey)
      .set('x-bonsai-visitor-secret', visitorSecret)
      .send({ reason: 'again' })
      .expect(201);
    expect((reEscalated.body as EscalateBody).afterHours).toBe(true);
  });
});
