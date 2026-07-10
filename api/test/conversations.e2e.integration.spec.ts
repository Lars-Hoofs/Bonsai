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

interface ConversationSummaryBody {
  id: string;
  assignedAgentId: string | null;
}

describe('agent presence + conversation assignment e2e (#21)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let idp: TestIdp;
  let ownerToken: string;
  let tenantId: string;
  let projectId: string;
  let widgetKey: string;

  const agentBase = (): string =>
    `/v1/tenants/${tenantId}/projects/${projectId}/conversations`;
  const presenceUrl = (): string =>
    `/v1/tenants/${tenantId}/agents/me/presence`;
  const widgetBase = '/v1/widget/conversations';
  const ownerAuth = (): { Authorization: string } => ({
    Authorization: `Bearer ${ownerToken}`,
  });
  const bearer = (token: string): { Authorization: string } => ({
    Authorization: `Bearer ${token}`,
  });

  async function makeAgent(email: string, sub: string): Promise<string> {
    const token = await idp.sign({ sub, email });
    // Any authenticated call upserts the user row so they can be added as a
    // member by email.
    await request(app.getHttpServer())
      .get('/v1/tenants')
      .set(bearer(token))
      .expect(200);
    await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/members`)
      .set(ownerAuth())
      .send({ email, role: 'agent' })
      .expect(201);
    return token;
  }

  async function escalateNewConversation(): Promise<{
    conversationId: string;
  }> {
    const started = await request(app.getHttpServer())
      .post(widgetBase)
      .set('x-bonsai-key', widgetKey)
      .send({ language: 'nl' })
      .expect(201);
    const { id: conversationId, visitorSecret } = started.body as {
      id: string;
      visitorSecret: string;
    };
    await request(app.getHttpServer())
      .post(`${widgetBase}/${conversationId}/escalate`)
      .set('x-bonsai-key', widgetKey)
      .set('x-bonsai-visitor-secret', visitorSecret)
      .send({ reason: 'visitor_request' })
      .expect(201);
    return { conversationId };
  }

  beforeAll(async () => {
    ({ container, pool } = await startPg());
    ({ app, idp } = await buildTestApp(pool));
    ownerToken = await idp.sign({
      sub: 'oidc|owner21',
      email: 'owner21@acme.eu',
    });
    const t = await request(app.getHttpServer())
      .post('/v1/tenants')
      .set(ownerAuth())
      .send({ name: 'Acme21', slug: 'acme-21' })
      .expect(201);
    tenantId = (t.body as IdBody).id;
    const p = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/projects`)
      .set(ownerAuth())
      .send({ name: 'Bot21' })
      .expect(201);
    projectId = (p.body as IdBody).id;
    const key = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/api-keys`)
      .set(ownerAuth())
      .send({ name: 'widget21', kind: 'public_widget', projectId })
      .expect(201);
    widgetKey = (key.body as { key: string }).key;
  }, 120000);

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('auto-assigns a new escalation to the available agent, not the away one', async () => {
    const availableToken = await makeAgent(
      'available1@acme.eu',
      'oidc|available1',
    );
    const awayToken = await makeAgent('away1@acme.eu', 'oidc|away1');

    await request(app.getHttpServer())
      .put(presenceUrl())
      .set(bearer(availableToken))
      .send({ status: 'available' })
      .expect(200);
    await request(app.getHttpServer())
      .put(presenceUrl())
      .set(bearer(awayToken))
      .send({ status: 'away' })
      .expect(200);

    const { conversationId } = await escalateNewConversation();

    const view = await request(app.getHttpServer())
      .get(`${agentBase()}/${conversationId}`)
      .set(ownerAuth())
      .expect(200);
    const convo = (view.body as { conversation: ConversationSummaryBody })
      .conversation;

    // Must be assigned to the available agent, and specifically not the
    // away one (asserted via the inbox filter below too).
    expect(convo.assignedAgentId).not.toBeNull();

    const inboxMe = await request(app.getHttpServer())
      .get(`${agentBase()}?status=handover&assignee=me`)
      .set(bearer(availableToken))
      .expect(200);
    expect(
      (inboxMe.body as ConversationSummaryBody[]).map((c) => c.id),
    ).toContain(conversationId);

    const inboxAway = await request(app.getHttpServer())
      .get(`${agentBase()}?status=handover&assignee=me`)
      .set(bearer(awayToken))
      .expect(200);
    expect(
      (inboxAway.body as ConversationSummaryBody[]).map((c) => c.id),
    ).not.toContain(conversationId);
  });

  it('assigns to the least-busy of two available agents', async () => {
    const busyToken = await makeAgent('busy2@acme.eu', 'oidc|busy2');
    const freeToken = await makeAgent('free2@acme.eu', 'oidc|free2');

    await request(app.getHttpServer())
      .put(presenceUrl())
      .set(bearer(busyToken))
      .send({ status: 'available' })
      .expect(200);

    // Give the busy agent an existing open assigned conversation before the
    // free agent comes online, by escalating while only busyToken is
    // available, then claiming it.
    const { conversationId: existing } = await escalateNewConversation();
    await request(app.getHttpServer())
      .post(`${agentBase()}/${existing}/assign`)
      .set(bearer(busyToken))
      .send({})
      .expect(201);

    await request(app.getHttpServer())
      .put(presenceUrl())
      .set(bearer(freeToken))
      .send({ status: 'available' })
      .expect(200);

    const { conversationId: fresh } = await escalateNewConversation();
    const view = await request(app.getHttpServer())
      .get(`${agentBase()}/${fresh}`)
      .set(ownerAuth())
      .expect(200);
    const convo = (view.body as { conversation: ConversationSummaryBody })
      .conversation;
    expect(convo.assignedAgentId).not.toBeNull();

    const inboxFree = await request(app.getHttpServer())
      .get(`${agentBase()}?status=handover&assignee=me`)
      .set(bearer(freeToken))
      .expect(200);
    expect(
      (inboxFree.body as ConversationSummaryBody[]).map((c) => c.id),
    ).toContain(fresh);

    const inboxBusy = await request(app.getHttpServer())
      .get(`${agentBase()}?status=handover&assignee=me`)
      .set(bearer(busyToken))
      .expect(200);
    expect(
      (inboxBusy.body as ConversationSummaryBody[]).map((c) => c.id),
    ).not.toContain(fresh);
  });

  it('lets an agent claim an unassigned conversation and audits conversation.assigned', async () => {
    // Mark every agent made available by earlier tests in this describe
    // block as away, so this escalation has no one to auto-assign to.
    await pool.query(
      `UPDATE agent_presence SET status = 'away' WHERE tenant_id = $1`,
      [tenantId],
    );

    // No one available -> escalation lands unassigned.
    const { conversationId } = await escalateNewConversation();

    const claimerToken = await makeAgent('claimer3@acme.eu', 'oidc|claimer3');

    const unassignedBefore = await request(app.getHttpServer())
      .get(`${agentBase()}?status=handover&assignee=unassigned`)
      .set(ownerAuth())
      .expect(200);
    expect(
      (unassignedBefore.body as ConversationSummaryBody[]).map((c) => c.id),
    ).toContain(conversationId);

    const claimed = await request(app.getHttpServer())
      .post(`${agentBase()}/${conversationId}/assign`)
      .set(bearer(claimerToken))
      .send({})
      .expect(201);
    expect((claimed.body as ConversationSummaryBody).assignedAgentId).toEqual(
      expect.any(String),
    );

    const auditRows = await pool.query<{
      metadata: { assignedAgentId: string };
    }>(
      `SELECT metadata FROM audit_log WHERE action = 'conversation.assigned' AND resource = $1`,
      [`conversation:${conversationId}`],
    );
    expect(auditRows.rowCount).toBe(1);
    expect(auditRows.rows[0].metadata.assignedAgentId).toBe(
      (claimed.body as ConversationSummaryBody).assignedAgentId,
    );

    const unassignedAfter = await request(app.getHttpServer())
      .get(`${agentBase()}?status=handover&assignee=unassigned`)
      .set(ownerAuth())
      .expect(200);
    expect(
      (unassignedAfter.body as ConversationSummaryBody[]).map((c) => c.id),
    ).not.toContain(conversationId);
  });

  it('transfers an assigned conversation to another agent, records history + audit, and posts the note (#39)', async () => {
    const fromToken = await makeAgent('from39@acme.eu', 'oidc|from39');
    const toToken = await makeAgent('to39@acme.eu', 'oidc|to39');

    // Only the "from" agent is available, so the escalation auto-assigns to
    // them; the "to" agent is a valid agent-role member either way.
    await pool.query(
      `UPDATE agent_presence SET status = 'away' WHERE tenant_id = $1`,
      [tenantId],
    );
    await request(app.getHttpServer())
      .put(presenceUrl())
      .set(bearer(fromToken))
      .send({ status: 'available' })
      .expect(200);

    const { conversationId } = await escalateNewConversation();

    // Establish a known "from" assignment by claiming as fromToken.
    const claimed = await request(app.getHttpServer())
      .post(`${agentBase()}/${conversationId}/assign`)
      .set(bearer(fromToken))
      .send({})
      .expect(201);
    const fromAgentId = (claimed.body as ConversationSummaryBody)
      .assignedAgentId;
    expect(fromAgentId).toEqual(expect.any(String));

    // Resolve the "to" agent's user id (owner can see the whole inbox, but we
    // need the id itself). Transfer to that agent with a note.
    const membersRow = await pool.query<{ user_id: string; email: string }>(
      `SELECT m.user_id, u.email
         FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.tenant_id = $1 AND u.email = 'to39@acme.eu'`,
      [tenantId],
    );
    const toAgentId = membersRow.rows[0].user_id;

    const transferred = await request(app.getHttpServer())
      .post(`${agentBase()}/${conversationId}/transfer`)
      .set(bearer(fromToken))
      .send({ toAgentUserId: toAgentId, note: 'Klant vraagt naar facturatie.' })
      .expect(201);
    expect((transferred.body as ConversationSummaryBody).assignedAgentId).toBe(
      toAgentId,
    );

    // Now shows up in the "to" agent's inbox and no longer the "from" one.
    const inboxTo = await request(app.getHttpServer())
      .get(`${agentBase()}?status=handover&assignee=me`)
      .set(bearer(toToken))
      .expect(200);
    expect(
      (inboxTo.body as ConversationSummaryBody[]).map((c) => c.id),
    ).toContain(conversationId);
    const inboxFrom = await request(app.getHttpServer())
      .get(`${agentBase()}?status=handover&assignee=me`)
      .set(bearer(fromToken))
      .expect(200);
    expect(
      (inboxFrom.body as ConversationSummaryBody[]).map((c) => c.id),
    ).not.toContain(conversationId);

    // History row recorded with from/to/actor + note.
    const tenantRow = await pool.query<{ schema_name: string }>(
      'SELECT schema_name FROM tenants WHERE id = $1',
      [tenantId],
    );
    const tenantSchema = tenantRow.rows[0].schema_name;
    const transfers = await pool.query<{
      from_agent_user_id: string | null;
      to_agent_user_id: string;
      transferred_by_user_id: string;
      note: string | null;
    }>(
      `SELECT from_agent_user_id, to_agent_user_id, transferred_by_user_id, note
         FROM "${tenantSchema}".conversation_transfers
        WHERE conversation_id = $1`,
      [conversationId],
    );
    expect(transfers.rowCount).toBe(1);
    expect(transfers.rows[0].from_agent_user_id).toBe(fromAgentId);
    expect(transfers.rows[0].to_agent_user_id).toBe(toAgentId);
    expect(transfers.rows[0].transferred_by_user_id).toBe(fromAgentId);
    expect(transfers.rows[0].note).toBe('Klant vraagt naar facturatie.');

    // Audit trail records conversation.transferred.
    const auditRows = await pool.query<{
      metadata: { fromAgentUserId: string | null; toAgentUserId: string };
    }>(
      `SELECT metadata FROM audit_log WHERE action = 'conversation.transferred' AND resource = $1`,
      [`conversation:${conversationId}`],
    );
    expect(auditRows.rowCount).toBe(1);
    expect(auditRows.rows[0].metadata.toAgentUserId).toBe(toAgentId);

    // The note is posted into the thread as a system message.
    const view = await request(app.getHttpServer())
      .get(`${agentBase()}/${conversationId}`)
      .set(ownerAuth())
      .expect(200);
    const messages = (
      view.body as { messages: { role: string; content: string }[] }
    ).messages;
    expect(
      messages.some(
        (m) =>
          m.role === 'system' && m.content === 'Klant vraagt naar facturatie.',
      ),
    ).toBe(true);
  });

  it('rejects transferring to a non-agent and a conversation not in handover (#39)', async () => {
    const agentToken = await makeAgent('agent39b@acme.eu', 'oidc|agent39b');
    await pool.query(
      `UPDATE agent_presence SET status = 'away' WHERE tenant_id = $1`,
      [tenantId],
    );
    await request(app.getHttpServer())
      .put(presenceUrl())
      .set(bearer(agentToken))
      .send({ status: 'available' })
      .expect(200);

    const { conversationId } = await escalateNewConversation();

    // A viewer is a member but below agent rank -> 400. Authenticate the
    // viewer first so their user row is upserted, then add them by email
    // (mirrors makeAgent's ordering).
    await request(app.getHttpServer())
      .get('/v1/tenants')
      .set(
        bearer(
          await idp.sign({ sub: 'oidc|viewer39', email: 'viewer39@acme.eu' }),
        ),
      )
      .expect(200);
    await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/members`)
      .set(ownerAuth())
      .send({ email: 'viewer39@acme.eu', role: 'viewer' })
      .expect(201);
    const viewerRow = await pool.query<{ user_id: string }>(
      `SELECT m.user_id FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.tenant_id = $1 AND u.email = 'viewer39@acme.eu'`,
      [tenantId],
    );
    await request(app.getHttpServer())
      .post(`${agentBase()}/${conversationId}/transfer`)
      .set(bearer(agentToken))
      .send({ toAgentUserId: viewerRow.rows[0].user_id })
      .expect(400);

    // A bot-driven (not-in-handover) conversation can't be transferred.
    const started = await request(app.getHttpServer())
      .post(widgetBase)
      .set('x-bonsai-key', widgetKey)
      .send({ language: 'nl' })
      .expect(201);
    const botConvoId = (started.body as { id: string }).id;
    const otherAgentToken = await makeAgent(
      'agent39c@acme.eu',
      'oidc|agent39c',
    );
    void otherAgentToken;
    const otherRow = await pool.query<{ user_id: string }>(
      `SELECT m.user_id FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.tenant_id = $1 AND u.email = 'agent39c@acme.eu'`,
      [tenantId],
    );
    await request(app.getHttpServer())
      .post(`${agentBase()}/${botConvoId}/transfer`)
      .set(bearer(agentToken))
      .send({ toAgentUserId: otherRow.rows[0].user_id })
      .expect(400);
  });

  it('rejects presence + assign for a viewer (403)', async () => {
    const viewerToken = await idp.sign({
      sub: 'oidc|viewer4',
      email: 'viewer4@acme.eu',
    });
    await request(app.getHttpServer())
      .get('/v1/tenants')
      .set(bearer(viewerToken))
      .expect(200);
    await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/members`)
      .set(ownerAuth())
      .send({ email: 'viewer4@acme.eu', role: 'viewer' })
      .expect(201);

    await request(app.getHttpServer())
      .put(presenceUrl())
      .set(bearer(viewerToken))
      .send({ status: 'available' })
      .expect(403);

    const { conversationId } = await escalateNewConversation();
    await request(app.getHttpServer())
      .post(`${agentBase()}/${conversationId}/assign`)
      .set(bearer(viewerToken))
      .send({})
      .expect(403);
  });
});
