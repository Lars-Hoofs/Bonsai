import { Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { TenantDbService } from '../../tenancy/tenant-db.service';
import type { AnswerOverrides } from '../answer.service';
import { EvalService } from './eval.service';
import type { EvalCaseResult } from './eval.service';

export interface ExperimentVariant {
  id: string;
  experimentId: string;
  name: string;
  /** null = use the built-in answering system prompt. */
  systemPrompt: string | null;
  /** null = use the project's configured confidenceThreshold. */
  confidenceThreshold: number | null;
  createdAt: string;
}

export interface Experiment {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  createdAt: string;
  variants: ExperimentVariant[];
}

export interface CreateVariantInput {
  name: string;
  systemPrompt?: string | null;
  confidenceThreshold?: number | null;
}

export interface CreateExperimentInput {
  name: string;
  description?: string | null;
  variants: CreateVariantInput[];
}

/** Per-variant comparative score in an experiment run. */
export interface VariantRunResult {
  variantId: string;
  variantName: string;
  total: number;
  passed: number;
  /** passed / total in [0, 1] (0 when there are no cases). */
  score: number;
  results: EvalCaseResult[];
}

export interface ExperimentRunSummary {
  runId: string;
  experimentId: string;
  total: number;
  /** The highest-scoring variant (ties broken by run order); null if no variants. */
  bestVariantId: string | null;
  variants: VariantRunResult[];
}

export interface ExperimentRun {
  id: string;
  experimentId: string;
  projectId: string;
  total: number;
  bestVariantId: string | null;
  results: VariantRunResult[];
  createdAt: string;
}

function mapVariantRow(r: Record<string, unknown>): ExperimentVariant {
  return {
    id: r.id as string,
    experimentId: r.experiment_id as string,
    name: r.name as string,
    systemPrompt: (r.system_prompt as string | null) ?? null,
    confidenceThreshold:
      r.confidence_threshold === null || r.confidence_threshold === undefined
        ? null
        : Number(r.confidence_threshold),
    createdAt: String(r.created_at),
  };
}

function mapRunRow(r: Record<string, unknown>): ExperimentRun {
  return {
    id: r.id as string,
    experimentId: r.experiment_id as string,
    projectId: r.project_id as string,
    total: r.total as number,
    bestVariantId: (r.best_variant_id as string | null) ?? null,
    results: (r.results as VariantRunResult[]) ?? [],
    createdAt: String(r.created_at),
  };
}

@Injectable()
export class ExperimentService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly evalService: EvalService,
  ) {}

  /**
   * Creates an experiment and its variants atomically. A variant maps 1:1 to
   * an `AnswerOverrides`: `systemPrompt` (null = built-in prompt) and
   * `confidenceThreshold` (null = project setting).
   */
  create(
    schemaName: string,
    projectId: string,
    input: CreateExperimentInput,
  ): Promise<Experiment> {
    return this.tenantDb.withTenant(schemaName, async (db) => {
      const exp = (
        await db.execute(sql`
          INSERT INTO eval_experiments (project_id, name, description)
          VALUES (${projectId}, ${input.name}, ${input.description ?? null})
          RETURNING *`)
      ).rows[0];
      const experimentId = (exp as { id: string }).id;

      const variants: ExperimentVariant[] = [];
      for (const v of input.variants) {
        const row = (
          await db.execute(sql`
            INSERT INTO eval_experiment_variants
              (experiment_id, name, system_prompt, confidence_threshold)
            VALUES (
              ${experimentId},
              ${v.name},
              ${v.systemPrompt ?? null},
              ${v.confidenceThreshold ?? null}
            )
            RETURNING *`)
        ).rows[0];
        variants.push(mapVariantRow(row));
      }

      return {
        id: experimentId,
        projectId,
        name: (exp as { name: string }).name,
        description:
          (exp as { description: string | null }).description ?? null,
        createdAt: String((exp as { created_at: unknown }).created_at),
        variants,
      };
    });
  }

  list(schemaName: string, projectId: string): Promise<Experiment[]> {
    return this.tenantDb.withTenant(schemaName, async (db) => {
      const exps = (
        await db.execute(sql`
          SELECT * FROM eval_experiments
          WHERE project_id = ${projectId} ORDER BY created_at DESC`)
      ).rows;
      const result: Experiment[] = [];
      for (const e of exps) {
        const experimentId = (e as { id: string }).id;
        const variants = (
          await db.execute(sql`
            SELECT * FROM eval_experiment_variants
            WHERE experiment_id = ${experimentId} ORDER BY created_at`)
        ).rows.map(mapVariantRow);
        result.push({
          id: experimentId,
          projectId,
          name: (e as { name: string }).name,
          description:
            (e as { description: string | null }).description ?? null,
          createdAt: String((e as { created_at: unknown }).created_at),
          variants,
        });
      }
      return result;
    });
  }

  async get(
    schemaName: string,
    projectId: string,
    experimentId: string,
  ): Promise<Experiment> {
    return this.tenantDb.withTenant(schemaName, async (db) => {
      const e = (
        await db.execute(sql`
          SELECT * FROM eval_experiments
          WHERE id = ${experimentId} AND project_id = ${projectId}`)
      ).rows[0];
      if (!e) throw new NotFoundException('Experiment not found');
      const variants = (
        await db.execute(sql`
          SELECT * FROM eval_experiment_variants
          WHERE experiment_id = ${experimentId} ORDER BY created_at`)
      ).rows.map(mapVariantRow);
      return {
        id: (e as { id: string }).id,
        projectId,
        name: (e as { name: string }).name,
        description: (e as { description: string | null }).description ?? null,
        createdAt: String((e as { created_at: unknown }).created_at),
        variants,
      };
    });
  }

  async remove(
    schemaName: string,
    projectId: string,
    experimentId: string,
  ): Promise<void> {
    const rows = await this.tenantDb.withTenant(schemaName, async (db) => {
      return (
        await db.execute(sql`
          DELETE FROM eval_experiments
          WHERE id = ${experimentId} AND project_id = ${projectId}
          RETURNING id`)
      ).rows;
    });
    if (!rows[0]) throw new NotFoundException('Experiment not found');
  }

  listRuns(
    schemaName: string,
    projectId: string,
    experimentId: string,
  ): Promise<ExperimentRun[]> {
    return this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(sql`
        SELECT * FROM eval_experiment_runs
        WHERE experiment_id = ${experimentId} AND project_id = ${projectId}
        ORDER BY created_at DESC LIMIT 50`);
      return r.rows.map(mapRunRow);
    });
  }

  /**
   * Runs the project's eval_cases against EVERY variant of the experiment and
   * produces comparative scores, so the best variant can be chosen. Reuses the
   * existing eval scoring core (`EvalService.scoreCases`), passing each
   * variant's prompt/threshold as `AnswerOverrides`. The shared case set is
   * loaded once. Persists one `eval_experiment_runs` row and returns the
   * summary. Live answering and the project's own settings are never touched.
   */
  async run(
    schemaName: string,
    projectId: string,
    experimentId: string,
  ): Promise<ExperimentRunSummary> {
    const experiment = await this.get(schemaName, projectId, experimentId);
    const cases = await this.evalService.list(schemaName, projectId);
    const total = cases.length;

    const variants: VariantRunResult[] = [];
    for (const v of experiment.variants) {
      const overrides: AnswerOverrides = {
        systemPrompt: v.systemPrompt ?? undefined,
        confidenceThreshold: v.confidenceThreshold ?? undefined,
      };
      const results = await this.evalService.scoreCases(
        schemaName,
        projectId,
        cases,
        overrides,
      );
      const passed = results.filter((r) => r.pass).length;
      variants.push({
        variantId: v.id,
        variantName: v.name,
        total,
        passed,
        score: total === 0 ? 0 : passed / total,
        results,
      });
    }

    const bestVariantId = pickBestVariantId(variants);

    const runId = await this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(sql`
        INSERT INTO eval_experiment_runs
          (experiment_id, project_id, total, best_variant_id, results)
        VALUES (
          ${experimentId},
          ${projectId},
          ${total},
          ${bestVariantId},
          ${JSON.stringify(variants)}::jsonb
        )
        RETURNING id`);
      return (r.rows[0] as { id: string }).id;
    });

    return { runId, experimentId, total, bestVariantId, variants };
  }
}

/**
 * Picks the winning variant of an experiment run: the one with the highest
 * `score` (passed/total). Ties are broken by run order — the FIRST variant
 * with the max score wins, so the result is stable and deterministic. Returns
 * null for an empty variant list.
 */
export function pickBestVariantId(
  variants: Pick<VariantRunResult, 'variantId' | 'score'>[],
): string | null {
  if (variants.length === 0) return null;
  return variants.reduce((best, v) => (v.score > best.score ? v : best))
    .variantId;
}
