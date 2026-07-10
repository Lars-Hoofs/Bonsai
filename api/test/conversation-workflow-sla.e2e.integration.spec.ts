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
interface SlaState {
  firstResponseDueAt: string | null;
  resolutionDueAt: string | null;
  firstRespondedAt: string | null;
  resolvedAt: string | null;
  firstResponseBreached: boolean;
  resolutionBreached: boolean;
}
interface ConversationSummaryBody {
  id: string;
  workflowStatus: string;
  sla: SlaState;
}
interface ConvoView {
  conversation: ConversationSummaryBody;
}

/**
 * #37 status workflow (open/pending/resolved) + SLA timers, end to end:
 * transitions via the agent API, SLA deadlines stamped from project settings,
 * first-response + resolution milestones, and breach detection.
 */
describe('conversation workflow status + SLA timers e2e (#37)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: INestApplication;
  let idp: TestIdp;
  let token: string;
  let tenantId: string;
  let tenantSchema: string;
  let projectId: string;
  let widgetKey: string;

  const agentBase = (): string =>
    `/v1/tenants/${tenantId}/projects/${projectId}/conversations`;
  const widgetBase = '/v1/widget/conversations';
  const auth = (): { Authorization: string } => ({
    Authorization: `Bearer ${token}`,
  });

  async function startConversation(): Promise<StartBody> {
    const started = await request(app.getHttpServer())
      .post(widgetBase)
      .set('x-bonsai-key', widgetKey)
      .send({ language: 'nl' })
      .expect(201);
    return started.body as StartBody;
  }

  beforeAll(async () => {
    ({ container, pool } = await startPg());
    ({ app, idp } = await buildTestApp(pool));
    token = await idp.sign({ sub: 'oidc|owner37', email: 'owner37@acme.eu' });
    const t = await request(app.getHttpServer())
      .post('/v1/tenants')
      .set(auth())
      .send({ name: 'Acme37', slug: 'acme-37' })
      .expect(201);
    tenantId = (t.body as IdBody).id;
    const tenantRow = await pool.query<{ schema_name: string }>(
      'SELECT schema_name FROM tenants WHERE id = $1',
      [tenantId],
    );
    tenantSchema = tenantRow.rows[0].schema_name;
    const p = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/projects`)
      .set(auth())
      .send({ name: 'Bot37' })
      .expect(201);
    projectId = (p.body as IdBody).id;
    // Configure an SLA policy on the project: 15 min first response,
    // 120 min resolution. Written straight into settings jsonb (mirrors how
    // other tests configure businessHours).
    await pool.query(
      `UPDATE "${tenantSchema}".projects
         SET settings = jsonb_set(settings, '{sla}', $1::jsonb)
       WHERE id = $2`,
      [
        JSON.stringify({ firstResponseMinutes: 15, resolutionMinutes: 120 }),
        projectId,
      ],
    );
    const key = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/api-keys`)
      .set(auth())
      .send({ name: 'widget37', kind: 'public_widget', projectId })
      .expect(201);
    widgetKey = (key.body as { key: string }).key;
  }, 120000);

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  it('stamps SLA deadlines at start and defaults workflow status to open', async () => {
    const { id: conversationId } = await startConversation();

    const view = await request(app.getHttpServer())
      .get(`${agentBase()}/${conversationId}`)
      .set(auth())
      .expect(200);
    const convo = (view.body as ConvoView).conversation;
    expect(convo.workflowStatus).toBe('open');
    // Both deadlines present (project has an SLA policy), neither breached yet.
    expect(convo.sla.firstResponseDueAt).not.toBeNull();
    expect(convo.sla.resolutionDueAt).not.toBeNull();
    expect(convo.sla.firstResponseBreached).toBe(false);
    expect(convo.sla.resolutionBreached).toBe(false);
    expect(convo.sla.firstRespondedAt).toBeNull();
    expect(convo.sla.resolvedAt).toBeNull();
  });

  it('records first-response milestone on the first agent message', async () => {
    const { id: conversationId, visitorSecret } = await startConversation();
    // Escalate so the conversation is in handover and agentMessage is allowed.
    await request(app.getHttpServer())
      .post(`${widgetBase}/${conversationId}/escalate`)
      .set('x-bonsai-key', widgetKey)
      .set('x-bonsai-visitor-secret', visitorSecret)
      .send({ reason: 'visitor_request' })
      .expect(201);

    await request(app.getHttpServer())
      .post(`${agentBase()}/${conversationId}/agent-messages`)
      .set(auth())
      .send({ content: 'Hoi, ik help je!' })
      .expect(201);

    const view = await request(app.getHttpServer())
      .get(`${agentBase()}/${conversationId}`)
      .set(auth())
      .expect(200);
    const convo = (view.body as ConvoView).conversation;
    expect(convo.sla.firstRespondedAt).not.toBeNull();
    // First response was in time (well within 15 min), so not breached.
    expect(convo.sla.firstResponseBreached).toBe(false);
  });

  it('transitions open -> pending -> resolved and stamps resolved_at', async () => {
    const { id: conversationId } = await startConversation();

    const pending = await request(app.getHttpServer())
      .put(`${agentBase()}/${conversationId}/workflow-status`)
      .set(auth())
      .send({ status: 'pending' })
      .expect(200);
    expect((pending.body as ConversationSummaryBody).workflowStatus).toBe(
      'pending',
    );

    const resolved = await request(app.getHttpServer())
      .put(`${agentBase()}/${conversationId}/workflow-status`)
      .set(auth())
      .send({ status: 'resolved' })
      .expect(200);
    const resolvedBody = resolved.body as ConversationSummaryBody;
    expect(resolvedBody.workflowStatus).toBe('resolved');
    expect(resolvedBody.sla.resolvedAt).not.toBeNull();

    // Audit trail written for the transition.
    const auditRows = await pool.query<{
      metadata: { from: string; to: string };
    }>(
      `SELECT metadata FROM audit_log
         WHERE action = 'conversation.workflow_status_changed' AND resource = $1
         ORDER BY created_at`,
      [`conversation:${conversationId}`],
    );
    expect(auditRows.rowCount).toBe(2);
    expect(auditRows.rows[1].metadata).toEqual({
      from: 'pending',
      to: 'resolved',
    });

    // Reopening clears resolved_at (resolution SLA is live again).
    const reopened = await request(app.getHttpServer())
      .put(`${agentBase()}/${conversationId}/workflow-status`)
      .set(auth())
      .send({ status: 'open' })
      .expect(200);
    expect(
      (reopened.body as ConversationSummaryBody).sla.resolvedAt,
    ).toBeNull();
  });

  it('rejects a no-op transition (400)', async () => {
    const { id: conversationId } = await startConversation();
    await request(app.getHttpServer())
      .put(`${agentBase()}/${conversationId}/workflow-status`)
      .set(auth())
      .send({ status: 'open' })
      .expect(400);
  });

  it('rejects an invalid workflow status value (400)', async () => {
    const { id: conversationId } = await startConversation();
    await request(app.getHttpServer())
      .put(`${agentBase()}/${conversationId}/workflow-status`)
      .set(auth())
      .send({ status: 'nonsense' })
      .expect(400);
  });

  it('filters the inbox by workflow status', async () => {
    const { id: openId } = await startConversation();
    const { id: pendingId } = await startConversation();
    await request(app.getHttpServer())
      .put(`${agentBase()}/${pendingId}/workflow-status`)
      .set(auth())
      .send({ status: 'pending' })
      .expect(200);

    // Both conversations are still bot-driven (status=bot) so query that.
    const pendingInbox = await request(app.getHttpServer())
      .get(`${agentBase()}?status=bot&workflowStatus=pending`)
      .set(auth())
      .expect(200);
    const pendingIds = (pendingInbox.body as ConversationSummaryBody[]).map(
      (c) => c.id,
    );
    expect(pendingIds).toContain(pendingId);
    expect(pendingIds).not.toContain(openId);

    const openInbox = await request(app.getHttpServer())
      .get(`${agentBase()}?status=bot&workflowStatus=open`)
      .set(auth())
      .expect(200);
    const openIds = (openInbox.body as ConversationSummaryBody[]).map(
      (c) => c.id,
    );
    expect(openIds).toContain(openId);
    expect(openIds).not.toContain(pendingId);
  });

  it('detects a first-response SLA breach when the deadline passes unmet', async () => {
    const { id: conversationId } = await startConversation();
    // Force the first-response deadline into the past without any response yet.
    await pool.query(
      `UPDATE "${tenantSchema}".conversations
         SET first_response_due_at = now() - interval '1 minute'
       WHERE id = $1`,
      [conversationId],
    );

    const view = await request(app.getHttpServer())
      .get(`${agentBase()}/${conversationId}`)
      .set(auth())
      .expect(200);
    const convo = (view.body as ConvoView).conversation;
    expect(convo.sla.firstResponseBreached).toBe(true);
    expect(convo.sla.firstRespondedAt).toBeNull();
  });

  it('never breaches a project with no SLA policy', async () => {
    const p = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/projects`)
      .set(auth())
      .send({ name: 'NoSlaBot37' })
      .expect(201);
    const noSlaProjectId = (p.body as IdBody).id;
    const key = await request(app.getHttpServer())
      .post(`/v1/tenants/${tenantId}/api-keys`)
      .set(auth())
      .send({
        name: 'widget37-nosla',
        kind: 'public_widget',
        projectId: noSlaProjectId,
      })
      .expect(201);
    const noSlaKey = (key.body as { key: string }).key;

    const started = await request(app.getHttpServer())
      .post(widgetBase)
      .set('x-bonsai-key', noSlaKey)
      .send({ language: 'nl' })
      .expect(201);
    const conversationId = (started.body as StartBody).id;

    const view = await request(app.getHttpServer())
      .get(
        `/v1/tenants/${tenantId}/projects/${noSlaProjectId}/conversations/${conversationId}`,
      )
      .set(auth())
      .expect(200);
    const convo = (view.body as ConvoView).conversation;
    expect(convo.sla.firstResponseDueAt).toBeNull();
    expect(convo.sla.resolutionDueAt).toBeNull();
    expect(convo.sla.firstResponseBreached).toBe(false);
    expect(convo.sla.resolutionBreached).toBe(false);
  });
});
