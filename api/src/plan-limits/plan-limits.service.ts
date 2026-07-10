import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { APP_CONFIG } from '../config/config';
import type { AppConfig, PlanLimits } from '../config/config';
import { DB } from '../db/db.module';
import type { Db } from '../db/db.module';
import { tenants } from '../db/schema';
import { TenantDbService } from '../tenancy/tenant-db.service';

export interface TenantPlanView {
  plan: string;
  limits: PlanLimits;
  usage: {
    projects: number;
    members: number;
  };
}

/**
 * Self-managed plan/tier limits (#50) — no billing provider required. Limits
 * are a config-driven map (see PLAN_LIMITS_JSON / DEFAULT_PLAN_LIMITS in
 * config.ts) keyed by the tenant's `plan` column. A `null` field (or the
 * built-in 'enterprise' plan, which is entirely unlimited) means that
 * dimension is never enforced.
 *
 * Enforcement is advisory-lock-free / best-effort (a plain count-then-insert
 * check, same as the rest of the create paths in this codebase) — it isn't
 * meant to defend against a determined concurrent-request race, only to stop
 * normal usage from silently exceeding a tenant's plan.
 */
@Injectable()
export class PlanLimitsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly tenantDb: TenantDbService,
  ) {}

  private async getPlan(tenantId: string): Promise<string> {
    const [row] = await this.db
      .select({ plan: tenants.plan })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    // Tenant not found is not this service's concern to report — callers
    // (projects/knowledge-sources/tenants services) already resolve the
    // tenant before reaching here via the MembershipGuard. Default to
    // 'starter' limits defensively if this is ever called standalone.
    return row?.plan ?? 'starter';
  }

  getLimits(plan: string): PlanLimits {
    return (
      this.cfg.planLimits[plan] ?? {
        maxProjects: null,
        maxSourcesPerProject: null,
        maxMembers: null,
      }
    );
  }

  private async countProjects(schemaName: string): Promise<number> {
    return this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(sql`SELECT count(*)::int AS c FROM projects`);
      return (r.rows[0] as { c: number }).c;
    });
  }

  private async countSources(
    schemaName: string,
    projectId: string,
  ): Promise<number> {
    return this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`SELECT count(*)::int AS c FROM knowledge_sources WHERE project_id = ${projectId}`,
      );
      return (r.rows[0] as { c: number }).c;
    });
  }

  private async countMembers(tenantId: string): Promise<number> {
    const r = await this.db.execute(
      sql`SELECT count(*)::int AS c FROM memberships WHERE tenant_id = ${tenantId}`,
    );
    return (r.rows[0] as { c: number }).c;
  }

  async assertCanCreateProject(
    tenantId: string,
    schemaName: string,
  ): Promise<void> {
    const plan = await this.getPlan(tenantId);
    const limits = this.getLimits(plan);
    if (limits.maxProjects === null) return;
    const current = await this.countProjects(schemaName);
    if (current >= limits.maxProjects) {
      throw new ForbiddenException(
        `Plan limit reached: '${plan}' plan allows at most ${limits.maxProjects} project(s)`,
      );
    }
  }

  async assertCanCreateSource(
    tenantId: string,
    schemaName: string,
    projectId: string,
  ): Promise<void> {
    const plan = await this.getPlan(tenantId);
    const limits = this.getLimits(plan);
    if (limits.maxSourcesPerProject === null) return;
    const current = await this.countSources(schemaName, projectId);
    if (current >= limits.maxSourcesPerProject) {
      throw new ForbiddenException(
        `Plan limit reached: '${plan}' plan allows at most ${limits.maxSourcesPerProject} knowledge source(s) per project`,
      );
    }
  }

  async assertCanAddMember(tenantId: string): Promise<void> {
    const plan = await this.getPlan(tenantId);
    const limits = this.getLimits(plan);
    if (limits.maxMembers === null) return;
    const current = await this.countMembers(tenantId);
    if (current >= limits.maxMembers) {
      throw new ForbiddenException(
        `Plan limit reached: '${plan}' plan allows at most ${limits.maxMembers} member(s)`,
      );
    }
  }

  /** Tenant's plan + limits + current usage counts, for GET .../plan. */
  async getPlanView(
    tenantId: string,
    schemaName: string,
  ): Promise<TenantPlanView> {
    const plan = await this.getPlan(tenantId);
    const limits = this.getLimits(plan);
    const [projects, members] = await Promise.all([
      this.countProjects(schemaName),
      this.countMembers(tenantId),
    ]);
    return { plan, limits, usage: { projects, members } };
  }
}
