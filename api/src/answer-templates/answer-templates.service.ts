import { Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { TenantDbService } from '../tenancy/tenant-db.service';

export type TriggerType = 'keyword' | 'intent';

export interface AnswerTemplate {
  id: string;
  projectId: string;
  triggerType: TriggerType;
  trigger: string;
  answer: string;
  attribution: string | null;
  shortCircuit: boolean;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AnswerTemplateInput {
  triggerType: TriggerType;
  trigger: string;
  answer: string;
  attribution?: string;
  shortCircuit?: boolean;
  active?: boolean;
}

export interface AnswerTemplatePatch {
  triggerType?: TriggerType;
  trigger?: string;
  answer?: string;
  attribution?: string;
  shortCircuit?: boolean;
  active?: boolean;
}

function mapRow(r: Record<string, unknown>): AnswerTemplate {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    triggerType: r.trigger_type as TriggerType,
    trigger: r.trigger as string,
    answer: r.answer as string,
    attribution: (r.attribution as string | null) ?? null,
    shortCircuit: r.short_circuit as boolean,
    active: r.active as boolean,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

/**
 * Escapes a string for safe use inside a JS RegExp (used to word-match a
 * template trigger against the raw question text). Mirrors the helper in
 * SynonymsService.
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Returns true if `token` appears as a whole word (case-insensitive, Unicode)
 * in `question`. Used for both keyword and per-token intent matching.
 */
function wholeWordMatch(question: string, token: string): boolean {
  const re = new RegExp(`\\b${escapeRegExp(token)}\\b`, 'iu');
  return re.test(question);
}

/**
 * Decides whether an active template's trigger matches the incoming question:
 *  - keyword: the trigger (a single term) appears as a whole word.
 *  - intent:  EVERY whitespace-separated token of the trigger appears as a
 *             whole word (order-independent) — so 'openingstijden weekend'
 *             matches 'zijn jullie in het weekend open qua openingstijden'.
 * Deliberately simple and purely lexical: no LLM call, no external service.
 */
export function templateMatches(
  template: Pick<AnswerTemplate, 'triggerType' | 'trigger'>,
  question: string,
): boolean {
  const trigger = template.trigger.trim();
  if (trigger.length === 0) return false;
  if (template.triggerType === 'keyword') {
    return wholeWordMatch(question, trigger);
  }
  const tokens = trigger.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return false;
  return tokens.every((t) => wholeWordMatch(question, t));
}

@Injectable()
export class AnswerTemplatesService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly audit: AuditService,
  ) {}

  async create(
    schemaName: string,
    projectId: string,
    input: AnswerTemplateInput,
    actorUserId: string,
    tenantId: string,
  ): Promise<AnswerTemplate> {
    const row = await this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(sql`
        INSERT INTO answer_templates
          (project_id, trigger_type, trigger, answer, attribution, short_circuit, active)
        VALUES (
          ${projectId},
          ${input.triggerType},
          ${input.trigger},
          ${input.answer},
          ${input.attribution ?? null},
          ${input.shortCircuit ?? true},
          ${input.active ?? true}
        )
        RETURNING *`);
      return r.rows[0];
    });
    const template = mapRow(row);
    await this.audit.record({
      tenantId,
      actorUserId,
      action: 'answer_template.created',
      resource: `answer_template:${template.id}`,
    });
    return template;
  }

  async list(schemaName: string, projectId: string): Promise<AnswerTemplate[]> {
    return this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`SELECT * FROM answer_templates WHERE project_id = ${projectId} ORDER BY created_at`,
      );
      return r.rows.map(mapRow);
    });
  }

  async update(
    tenant: { id: string; schemaName: string },
    projectId: string,
    id: string,
    patch: AnswerTemplatePatch,
    actorUserId: string,
  ): Promise<AnswerTemplate> {
    const template = await this.tenantDb.withTenant(
      tenant.schemaName,
      async (db) => {
        const sets = [];
        if (patch.triggerType !== undefined) {
          sets.push(sql`trigger_type = ${patch.triggerType}`);
        }
        if (patch.trigger !== undefined) {
          sets.push(sql`trigger = ${patch.trigger}`);
        }
        if (patch.answer !== undefined) {
          sets.push(sql`answer = ${patch.answer}`);
        }
        if (patch.attribution !== undefined) {
          sets.push(sql`attribution = ${patch.attribution}`);
        }
        if (patch.shortCircuit !== undefined) {
          sets.push(sql`short_circuit = ${patch.shortCircuit}`);
        }
        if (patch.active !== undefined) {
          sets.push(sql`active = ${patch.active}`);
        }
        sets.push(sql`updated_at = now()`);
        const r = await db.execute(sql`
          UPDATE answer_templates
          SET ${sql.join(sets, sql`, `)}
          WHERE id = ${id} AND project_id = ${projectId}
          RETURNING *`);
        const updated = r.rows[0];
        if (!updated) throw new NotFoundException('Answer template not found');
        await this.audit.record(
          {
            tenantId: tenant.id,
            actorUserId,
            action: 'answer_template.updated',
            resource: `answer_template:${id}`,
          },
          db,
        );
        return updated;
      },
    );
    return mapRow(template);
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
          sql`DELETE FROM answer_templates WHERE id = ${id} AND project_id = ${projectId} RETURNING id`,
        )
      ).rows;
      if (!rows[0]) throw new NotFoundException('Answer template not found');
      await this.audit.record(
        {
          tenantId: tenant.id,
          actorUserId,
          action: 'answer_template.deleted',
          resource: `answer_template:${id}`,
        },
        db,
      );
    });
  }

  /**
   * Finds the first ACTIVE, short-circuiting template whose trigger matches
   * the incoming question (see `templateMatches`), for use by the answer
   * pipeline. Templates are considered in creation order, and only those with
   * `short_circuit = true` can short-circuit retrieval. Returns null when the
   * project has no such template — in which case the answer pipeline proceeds
   * exactly as before. Deliberately conservative and purely lexical (no LLM
   * call), mirroring SynonymsService.expandQuery's additive philosophy.
   */
  async matchShortCircuit(
    schemaName: string,
    projectId: string,
    question: string,
  ): Promise<AnswerTemplate | null> {
    const templates = await this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`SELECT * FROM answer_templates
            WHERE project_id = ${projectId}
              AND active = true
              AND short_circuit = true
            ORDER BY created_at`,
      );
      return r.rows.map(mapRow);
    });
    for (const t of templates) {
      if (templateMatches(t, question)) return t;
    }
    return null;
  }
}
