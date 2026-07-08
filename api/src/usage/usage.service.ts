import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../db/db.module';

export interface UsageView {
  period: string;
  metric: string;
  used: number;
  quota: number;
  remaining: number;
}

/** Current billing period as 'YYYY-MM' in UTC. */
export function currentPeriod(now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

@Injectable()
export class UsageService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  private period(): string {
    return currentPeriod(new Date());
  }

  /**
   * Enforces the tenant's monthly answer quota (cost cap). Throws 402 Payment
   * Required when the cap is reached, so an over-quota tenant cannot keep
   * driving paid AI calls.
   */
  async enforceAnswerQuota(tenantId: string): Promise<void> {
    const usage = await this.current(tenantId, 'answers');
    if (usage.used >= usage.quota) {
      throw new HttpException(
        `Monthly answer quota reached (${usage.quota}). Upgrade the plan to continue.`,
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
  }

  async recordAnswer(tenantId: string, count = 1): Promise<void> {
    await this.pool.query(
      `INSERT INTO usage_records (tenant_id, period, metric, value)
       VALUES ($1, $2, 'answers', $3)
       ON CONFLICT (tenant_id, period, metric)
       DO UPDATE SET value = usage_records.value + EXCLUDED.value`,
      [tenantId, this.period(), count],
    );
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
}
