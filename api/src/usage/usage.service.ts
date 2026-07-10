import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../db/db.module';
import { APP_CONFIG } from '../config/config';
import type { AppConfig } from '../config/config';

export interface UsageView {
  period: string;
  metric: string;
  used: number;
  quota: number;
  remaining: number;
}

export interface MonthlyUsage {
  period: string;
  answers: number;
  estimatedTokens: number;
  estimatedCost: number;
}

export interface UsageSummary {
  months: MonthlyUsage[];
  totalAnswers: number;
  totalEstimatedTokens: number;
  totalEstimatedCost: number;
  costPer1kTokens: number;
  estTokensPerAnswer: number;
}

/** Current billing period as 'YYYY-MM' in UTC. */
export function currentPeriod(now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/**
 * The N most recent 'YYYY-MM' periods (UTC), most-recent-last, ending at
 * (and including) `now`'s period.
 */
export function trailingPeriods(now: Date, count: number): string[] {
  const periods: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1),
    );
    periods.push(currentPeriod(d));
  }
  return periods;
}

@Injectable()
export class UsageService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  private period(): string {
    return currentPeriod(new Date());
  }

  /**
   * Atomically reserves capacity for one answer against the tenant's monthly
   * quota (cost cap) BEFORE the (expensive, slow) LLM round-trip is made.
   *
   * This closes a check-then-act (TOCTOU) race: the previous approach read
   * `used < quota` and incremented separately, after the LLM call, so
   * concurrent requests could all observe spare capacity and blow through
   * the cap. Here the read-quota / increment-if-under-quota / write happens
   * in a single SQL statement, so Postgres's row-level locking serializes
   * concurrent reservations for the same tenant+period and only ever lets
   * exactly `quota` reservations through.
   *
   * Throws 402 Payment Required when the cap is already reached (or the
   * quota is 0), so an over-quota tenant cannot keep driving paid AI calls.
   */
  async reserveAnswer(tenantId: string): Promise<void> {
    const period = this.period();
    // Billing disabled (default for now): meter usage for analytics but never
    // enforce the quota -- every tenant behaves as if on a paid plan.
    if (!this.cfg.billingEnabled) {
      await this.pool.query(
        `INSERT INTO usage_records (tenant_id, period, metric, value)
         VALUES ($1, $2, 'answers', 1)
         ON CONFLICT (tenant_id, period, metric)
         DO UPDATE SET value = usage_records.value + 1`,
        [tenantId, period],
      );
      return;
    }
    const result = await this.pool.query<{ value: string }>(
      `INSERT INTO usage_records (tenant_id, period, metric, value)
       SELECT $1, $2, 'answers', 1
       FROM tenants
       WHERE tenants.id = $1 AND tenants.monthly_answer_quota > 0
       ON CONFLICT (tenant_id, period, metric)
       DO UPDATE SET value = usage_records.value + 1
       WHERE usage_records.value < (
         SELECT monthly_answer_quota FROM tenants WHERE id = $1
       )
       RETURNING value`,
      [tenantId, period],
    );
    if (result.rowCount === 0) {
      const usage = await this.current(tenantId, 'answers');
      throw new HttpException(
        `Monthly answer quota reached (${usage.quota}). Upgrade the plan to continue.`,
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
  }

  async current(tenantId: string, metric = 'answers'): Promise<UsageView> {
    const period = this.period();
    const q = await this.pool.query<{ monthly_answer_quota: number }>(
      `SELECT monthly_answer_quota FROM tenants WHERE id = $1`,
      [tenantId],
    );
    const quota = q.rows[0]?.monthly_answer_quota ?? 0;
    const u = await this.pool.query<{ value: string }>(
      `SELECT value FROM usage_records WHERE tenant_id = $1 AND period = $2 AND metric = $3`,
      [tenantId, period, metric],
    );
    const used = u.rows[0] ? Number(u.rows[0].value) : 0;
    return {
      period,
      metric,
      used,
      quota,
      remaining: Math.max(0, quota - used),
    };
  }

  /**
   * Cost/usage analytics (#43): per-month 'answers' usage for the current +
   * last (months-1) periods, plus a rough cost estimate. The estimate is
   * deliberately simplistic (answers * estTokensPerAnswer / 1000 *
   * costPer1kTokens) -- it's a ballpark for the operator to budget against,
   * not a reconciled bill against an actual LLM provider invoice. When
   * costPer1kTokens is 0 (the default), estimatedCost is always 0, so this
   * feature has no external pricing dependency out of the box.
   */
  async summary(tenantId: string, months = 6): Promise<UsageSummary> {
    const periods = trailingPeriods(new Date(), months);
    const rows = await this.pool.query<{ period: string; value: string }>(
      `SELECT period, value FROM usage_records
       WHERE tenant_id = $1 AND metric = 'answers' AND period = ANY($2::text[])`,
      [tenantId, periods],
    );
    const byPeriod = new Map<string, number>(
      rows.rows.map((r) => [r.period, Number(r.value)]),
    );
    const { costPer1kTokens, estTokensPerAnswer } = this.cfg;
    const monthList: MonthlyUsage[] = periods.map((period) => {
      const answers = byPeriod.get(period) ?? 0;
      const estimatedTokens = answers * estTokensPerAnswer;
      const estimatedCost = (estimatedTokens / 1000) * costPer1kTokens;
      return { period, answers, estimatedTokens, estimatedCost };
    });
    const totalAnswers = monthList.reduce((s, m) => s + m.answers, 0);
    const totalEstimatedTokens = monthList.reduce(
      (s, m) => s + m.estimatedTokens,
      0,
    );
    const totalEstimatedCost = monthList.reduce(
      (s, m) => s + m.estimatedCost,
      0,
    );
    return {
      months: monthList,
      totalAnswers,
      totalEstimatedTokens,
      totalEstimatedCost,
      costPer1kTokens,
      estTokensPerAnswer,
    };
  }
}
