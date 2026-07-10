import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { TenantDbService } from '../tenancy/tenant-db.service';
import { MailService } from '../mail/mail.service';
import { safeFetch } from '../common/safe-fetch';

export type HandoverTargetKind = 'slack' | 'email';

export interface HandoverTarget {
  id: string;
  projectId: string;
  kind: HandoverTargetKind;
  target: string;
  createdAt: string;
}

export interface HandoverTargetInput {
  kind: HandoverTargetKind;
  target: string;
}

/**
 * Details of the handover event used to render the notification body sent to
 * each configured Slack/email target.
 */
export interface HandoverNotification {
  conversationId: string;
  reason: string;
  afterHours: boolean;
  assignedAgentId: string | null;
}

function mapRow(r: Record<string, unknown>): HandoverTarget {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    kind: r.kind as HandoverTargetKind,
    target: r.target as string,
    createdAt: String(r.created_at),
  };
}

/**
 * Manages per-project handover notification targets (#38) and fans a handover
 * out to every configured Slack incoming-webhook and email recipient.
 *
 * This is additive to the existing generic outbound `webhooks` delivery (which
 * already signs and posts the `conversation.escalated` event): Slack/email
 * targets receive a rendered, human-readable message instead of a raw JSON
 * event, and are validated per-channel (Slack URLs go through the SSRF guard,
 * email through the self-hosted SMTP MailService).
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly mail: MailService,
  ) {}

  async create(
    schemaName: string,
    projectId: string,
    input: HandoverTargetInput,
  ): Promise<HandoverTarget> {
    const row = await this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`INSERT INTO handover_notification_targets (project_id, kind, target)
            VALUES (${projectId}, ${input.kind}, ${input.target})
            RETURNING *`,
      );
      return r.rows[0];
    });
    return mapRow(row);
  }

  async list(schemaName: string, projectId: string): Promise<HandoverTarget[]> {
    return this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`SELECT * FROM handover_notification_targets
            WHERE project_id = ${projectId} ORDER BY created_at`,
      );
      return r.rows.map(mapRow);
    });
  }

  async remove(
    schemaName: string,
    projectId: string,
    id: string,
  ): Promise<void> {
    const ok = await this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`DELETE FROM handover_notification_targets
            WHERE id = ${id} AND project_id = ${projectId} RETURNING id`,
      );
      return r.rows.length > 0;
    });
    if (!ok) throw new NotFoundException('Notification target not found');
  }

  /**
   * Best-effort fan-out to every configured target for the project. Never
   * throws — a dead Slack endpoint or broken SMTP config must not roll back
   * or block the escalation itself. Each failure is logged and swallowed.
   */
  async notifyHandover(
    schemaName: string,
    projectId: string,
    event: HandoverNotification,
  ): Promise<void> {
    const targets = await this.list(schemaName, projectId);
    if (targets.length === 0) return;

    await Promise.all(
      targets.map((t) =>
        t.kind === 'slack'
          ? this.deliverSlack(t.target, event)
          : this.deliverEmail(t.target, event),
      ),
    );
  }

  private async deliverSlack(
    url: string,
    event: HandoverNotification,
  ): Promise<void> {
    try {
      const body = JSON.stringify({ text: this.renderText(event) });
      await safeFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
    } catch (err) {
      this.logger.warn(
        `Slack handover notification failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async deliverEmail(
    to: string,
    event: HandoverNotification,
  ): Promise<void> {
    try {
      await this.mail.send({
        to,
        subject: `Handover: conversation ${event.conversationId}`,
        text: this.renderText(event),
      });
    } catch (err) {
      this.logger.warn(
        `Email handover notification to ${to} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private renderText(event: HandoverNotification): string {
    const lines = [
      `Conversation ${event.conversationId} was handed over to a human.`,
      `Reason: ${event.reason}`,
      event.afterHours ? 'Note: escalated outside business hours.' : null,
      event.assignedAgentId
        ? `Assigned to agent ${event.assignedAgentId}.`
        : 'Currently unassigned — waiting to be claimed.',
    ];
    return lines.filter((l): l is string => l !== null).join('\n');
  }
}
