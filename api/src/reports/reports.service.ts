import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AnalyticsService } from '../analytics/analytics.service';
import { AuditService } from '../audit/audit.service';
import { TenantDbService } from '../tenancy/tenant-db.service';
import { UsageService } from '../usage/usage.service';
import {
  nextRunAt,
  isReportCadence,
  type ReportCadence,
} from './report-schedule';
import type { ReportData, ReportFormat } from './report-serialization';

export interface ReportSchedule {
  id: string;
  projectId: string;
  cadence: ReportCadence;
  format: ReportFormat;
  deliverEmail: boolean;
  deliverStorage: boolean;
  recipients: string[];
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleInput {
  cadence: ReportCadence;
  format: ReportFormat;
  deliverEmail?: boolean;
  deliverStorage?: boolean;
  recipients?: string[];
}

export interface ScheduleUpdate {
  cadence?: ReportCadence;
  format?: ReportFormat;
  deliverEmail?: boolean;
  deliverStorage?: boolean;
  recipients?: string[];
  enabled?: boolean;
}

function mapRow(r: Record<string, unknown>): ReportSchedule {
  const cadence = String(r.cadence);
  const lastRunAt = r.last_run_at as string | Date | null;
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    cadence: isReportCadence(cadence) ? cadence : 'weekly',
    format: (r.format as ReportFormat) ?? 'csv',
    deliverEmail: Boolean(r.deliver_email),
    deliverStorage: Boolean(r.deliver_storage),
    recipients: (r.recipients as string[]) ?? [],
    enabled: Boolean(r.enabled),
    lastRunAt: lastRunAt == null ? null : String(lastRunAt),
    nextRunAt: String(r.next_run_at),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

@Injectable()
export class ReportsService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly analytics: AnalyticsService,
    private readonly usage: UsageService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Builds the full report payload for a project by reusing the existing
   * analytics/usage aggregation (no new querying logic — this feature is a
   * serialization + delivery layer over those). `tenantId` is the
   * control-plane id (usage is metered per tenant); `schemaName` scopes the
   * tenant-local analytics/csat queries.
   */
  async generate(
    tenantId: string,
    schemaName: string,
    projectId: string,
  ): Promise<ReportData> {
    const [analytics, csat, usage] = await Promise.all([
      this.analytics.summary(schemaName, projectId),
      this.analytics.csat(schemaName, projectId),
      this.usage.summary(tenantId),
    ]);
    return {
      projectId,
      tenantId,
      generatedAt: new Date().toISOString(),
      analytics,
      csat,
      usage,
    };
  }

  async list(schemaName: string, projectId: string): Promise<ReportSchedule[]> {
    return this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`SELECT * FROM report_schedules WHERE project_id = ${projectId} ORDER BY created_at`,
      );
      return r.rows.map(mapRow);
    });
  }

  async create(
    tenant: { id: string; schemaName: string },
    projectId: string,
    input: ScheduleInput,
    actorUserId: string,
  ): Promise<ReportSchedule> {
    const deliverEmail = input.deliverEmail ?? false;
    const deliverStorage = input.deliverStorage ?? false;
    if (!deliverEmail && !deliverStorage) {
      throw new BadRequestException(
        'At least one delivery channel (deliverEmail or deliverStorage) must be enabled',
      );
    }
    const recipients = input.recipients ?? [];
    if (deliverEmail && recipients.length === 0) {
      throw new BadRequestException(
        'deliverEmail requires at least one recipient',
      );
    }
    const schedule = await this.tenantDb.withTenant(
      tenant.schemaName,
      async (db) => {
        const r = await db.execute(sql`
          INSERT INTO report_schedules
            (project_id, cadence, format, deliver_email, deliver_storage, recipients)
          VALUES
            (${projectId}, ${input.cadence}, ${input.format}, ${deliverEmail},
             ${deliverStorage}, ${sql.param(recipients)}::text[])
          RETURNING *`);
        const created = mapRow(r.rows[0]);
        await this.audit.record(
          {
            tenantId: tenant.id,
            actorUserId,
            action: 'report_schedule.created',
            resource: `report_schedule:${created.id}`,
          },
          db,
        );
        return created;
      },
    );
    return schedule;
  }

  async update(
    tenant: { id: string; schemaName: string },
    projectId: string,
    id: string,
    patch: ScheduleUpdate,
    actorUserId: string,
  ): Promise<ReportSchedule> {
    return this.tenantDb.withTenant(tenant.schemaName, async (db) => {
      const current = (
        await db.execute(
          sql`SELECT * FROM report_schedules WHERE id = ${id} AND project_id = ${projectId}`,
        )
      ).rows[0];
      if (!current) throw new NotFoundException('Report schedule not found');
      const existing = mapRow(current);

      const deliverEmail = patch.deliverEmail ?? existing.deliverEmail;
      const deliverStorage = patch.deliverStorage ?? existing.deliverStorage;
      if (!deliverEmail && !deliverStorage) {
        throw new BadRequestException(
          'At least one delivery channel (deliverEmail or deliverStorage) must be enabled',
        );
      }
      const recipients = patch.recipients ?? existing.recipients;
      if (deliverEmail && recipients.length === 0) {
        throw new BadRequestException(
          'deliverEmail requires at least one recipient',
        );
      }

      const r = await db.execute(sql`
        UPDATE report_schedules SET
          cadence = ${patch.cadence ?? existing.cadence},
          format = ${patch.format ?? existing.format},
          deliver_email = ${deliverEmail},
          deliver_storage = ${deliverStorage},
          recipients = ${sql.param(recipients)}::text[],
          enabled = ${patch.enabled ?? existing.enabled},
          updated_at = now()
        WHERE id = ${id} AND project_id = ${projectId}
        RETURNING *`);
      const updated = mapRow(r.rows[0]);
      await this.audit.record(
        {
          tenantId: tenant.id,
          actorUserId,
          action: 'report_schedule.updated',
          resource: `report_schedule:${id}`,
        },
        db,
      );
      return updated;
    });
  }

  async remove(
    tenant: { id: string; schemaName: string },
    projectId: string,
    id: string,
    actorUserId: string,
  ): Promise<void> {
    await this.tenantDb.withTenant(tenant.schemaName, async (db) => {
      const rows = (
        await db.execute(
          sql`DELETE FROM report_schedules WHERE id = ${id} AND project_id = ${projectId} RETURNING id`,
        )
      ).rows;
      if (!rows[0]) throw new NotFoundException('Report schedule not found');
      await this.audit.record(
        {
          tenantId: tenant.id,
          actorUserId,
          action: 'report_schedule.deleted',
          resource: `report_schedule:${id}`,
        },
        db,
      );
    });
  }

  /** Schedules in a tenant that are enabled and due at `now`. Used by the
   * runner; scoped to the tenant schema. */
  async dueSchedules(schemaName: string, now: Date): Promise<ReportSchedule[]> {
    return this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`SELECT * FROM report_schedules
            WHERE enabled = true AND next_run_at <= ${now.toISOString()}
            ORDER BY next_run_at`,
      );
      return r.rows.map(mapRow);
    });
  }

  /** Advances a schedule after a successful run: last_run_at=now, next_run_at
   * one cadence ahead of now. */
  async markRan(
    schemaName: string,
    id: string,
    cadence: ReportCadence,
    now: Date,
  ): Promise<void> {
    const next = nextRunAt(cadence, now);
    await this.tenantDb.withTenant(schemaName, (db) =>
      db.execute(
        sql`UPDATE report_schedules
            SET last_run_at = ${now.toISOString()}, next_run_at = ${next.toISOString()}, updated_at = now()
            WHERE id = ${id}`,
      ),
    );
  }
}
