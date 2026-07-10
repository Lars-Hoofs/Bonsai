import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../db/db.module';
import { APP_CONFIG } from '../config/config';
import type { AppConfig } from '../config/config';
import { MailService } from '../mail/mail.service';
import { StorageService } from '../storage/storage.service';
import { ReportsService, type ReportSchedule } from './reports.service';
import {
  contentType,
  reportFilename,
  serializeReport,
} from './report-serialization';

/**
 * In-process scheduled-report runner (#45). Deliberately a plain `setInterval`
 * loop rather than a Redis/BullMQ queue: scheduled reports must work in the
 * base self-hosted deploy, which has no Redis. It mirrors the reaper/scan
 * pattern (walk active tenants, act on due rows) but keeps the whole thing in
 * one process — day/week/month cadences don't need a distributed scheduler.
 *
 * Each tick: for every active tenant, find its due+enabled schedules, generate
 * the report, deliver it via MailModule (attachment) and/or StorageModule
 * (MinIO object), then advance next_run_at by the cadence. A failing schedule
 * is logged and skipped (its next_run_at is left untouched, so it retries next
 * tick) rather than aborting the whole scan.
 */
@Injectable()
export class ReportsRunnerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReportsRunnerService.name);
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly reports: ReportsService,
    private readonly mail: MailService,
    private readonly storage: StorageService,
    @Inject(PG_POOL) private readonly pool: Pool,
    @Optional() @Inject(APP_CONFIG) private readonly cfg?: AppConfig,
  ) {}

  onModuleInit(): void {
    if (!this.cfg?.reportsSchedulerEnabled) return;
    const everyMs = this.cfg.reportsIntervalMs;
    this.timer = setInterval(() => {
      this.tick().catch((err: unknown) =>
        this.logger.error(
          `Report scheduler tick failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }, everyMs);
    // Don't keep the event loop alive solely for the scheduler (so the process
    // can still exit cleanly / tests don't hang on a dangling timer).
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * One scan pass over every active tenant. Returns the number of schedules
   * successfully generated + delivered — exposed (and called directly by
   * tests) so the runner can be exercised deterministically without waiting on
   * the interval.
   */
  async tick(now: Date = new Date()): Promise<number> {
    const tenants = await this.pool.query<{
      id: string;
      schema_name: string;
    }>(`SELECT id, schema_name FROM tenants WHERE status = 'active'`);
    let delivered = 0;
    for (const t of tenants.rows) {
      let due: ReportSchedule[];
      try {
        due = await this.reports.dueSchedules(t.schema_name, now);
      } catch (err) {
        this.logger.warn(
          `Failed to load due schedules for tenant ${t.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      for (const schedule of due) {
        try {
          await this.runSchedule(t.id, t.schema_name, schedule, now);
          delivered++;
        } catch (err) {
          // Leave next_run_at untouched so a transient failure retries next
          // tick rather than silently skipping this period.
          this.logger.warn(
            `Report schedule ${schedule.id} (tenant ${t.id}) failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
    return delivered;
  }

  /** Generates, delivers, and advances a single due schedule. */
  async runSchedule(
    tenantId: string,
    schemaName: string,
    schedule: ReportSchedule,
    now: Date,
  ): Promise<void> {
    const data = await this.reports.generate(
      tenantId,
      schemaName,
      schedule.projectId,
    );
    const body = serializeReport(data, schedule.format);
    const filename = reportFilename(
      schedule.projectId,
      schedule.format,
      data.generatedAt,
    );
    const type = contentType(schedule.format);

    if (schedule.deliverStorage) {
      if (this.storage.enabled) {
        const key = `reports/${tenantId}/${schedule.projectId}/${filename}`;
        await this.storage.put(key, Buffer.from(body, 'utf8'), type);
      } else {
        this.logger.debug(
          `Storage delivery requested for schedule ${schedule.id} but object storage is not configured — skipping`,
        );
      }
    }

    if (schedule.deliverEmail && schedule.recipients.length > 0) {
      await this.mail.send({
        to: schedule.recipients.join(', '),
        subject: `Scheduled report for project ${schedule.projectId}`,
        text: `Attached is the scheduled ${schedule.cadence} report (${schedule.format.toUpperCase()}) generated at ${data.generatedAt}.`,
        attachments: [{ filename, content: body, contentType: type }],
      });
    }

    await this.reports.markRan(schemaName, schedule.id, schedule.cadence, now);
  }
}
