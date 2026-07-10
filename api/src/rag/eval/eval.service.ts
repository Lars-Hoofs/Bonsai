import { Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { TenantDbService } from '../../tenancy/tenant-db.service';
import { AnswerService } from '../answer.service';
import type { AnswerOverrides } from '../answer.service';

export interface EvalCase {
  id: string;
  projectId: string;
  question: string;
  expectRefusal: boolean;
  expectedSourceIds: string[];
  expectedSubstrings: string[];
  createdAt: string;
}

export interface CreateEvalCaseInput {
  question: string;
  expectRefusal?: boolean;
  expectedSourceIds?: string[];
  expectedSubstrings?: string[];
}

export interface EvalCaseResult {
  caseId: string;
  question: string;
  pass: boolean;
  refusalCorrect: boolean;
  citationOk: boolean;
  substringOk: boolean;
  refused: boolean;
}

export interface EvalRunSummary {
  runId: string;
  total: number;
  passed: number;
  results: EvalCaseResult[];
}

export interface EvalRun {
  id: string;
  projectId: string;
  total: number;
  passed: number;
  results: EvalCaseResult[];
  createdAt: string;
}

function mapCaseRow(r: Record<string, unknown>): EvalCase {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    question: r.question as string,
    expectRefusal: r.expect_refusal as boolean,
    expectedSourceIds: (r.expected_source_ids as string[]) ?? [],
    expectedSubstrings: (r.expected_substrings as string[]) ?? [],
    createdAt: String(r.created_at),
  };
}

function mapRunRow(r: Record<string, unknown>): EvalRun {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    total: r.total as number,
    passed: r.passed as number,
    results: (r.results as EvalCaseResult[]) ?? [],
    createdAt: String(r.created_at),
  };
}

@Injectable()
export class EvalService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly answerService: AnswerService,
  ) {}

  create(
    schemaName: string,
    projectId: string,
    input: CreateEvalCaseInput,
  ): Promise<EvalCase> {
    return this.tenantDb.withTenant(schemaName, async (db) => {
      // Bind the JS string arrays as single parameters via `sql.param` (cast
      // to uuid[]/text[]) rather than a bare interpolation, which drizzle
      // would instead splice as N separate comma-joined placeholders — see
      // WebhooksService.register for the same pattern/rationale.
      const r = await db.execute(sql`
        INSERT INTO eval_cases
          (project_id, question, expect_refusal, expected_source_ids, expected_substrings)
        VALUES (
          ${projectId},
          ${input.question},
          ${input.expectRefusal ?? false},
          ${sql.param(input.expectedSourceIds ?? [])}::uuid[],
          ${sql.param(input.expectedSubstrings ?? [])}::text[]
        )
        RETURNING *`);
      return mapCaseRow(r.rows[0]);
    });
  }

  list(schemaName: string, projectId: string): Promise<EvalCase[]> {
    return this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`SELECT * FROM eval_cases WHERE project_id = ${projectId} ORDER BY created_at`,
      );
      return r.rows.map(mapCaseRow);
    });
  }

  async remove(
    schemaName: string,
    projectId: string,
    caseId: string,
  ): Promise<void> {
    const rows = await this.tenantDb.withTenant(schemaName, async (db) => {
      return (
        await db.execute(
          sql`DELETE FROM eval_cases WHERE id = ${caseId} AND project_id = ${projectId} RETURNING id`,
        )
      ).rows;
    });
    if (!rows[0]) throw new NotFoundException('Eval case not found');
  }

  listRuns(schemaName: string, projectId: string): Promise<EvalRun[]> {
    return this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`SELECT * FROM eval_runs WHERE project_id = ${projectId}
            ORDER BY created_at DESC LIMIT 50`,
      );
      return r.rows.map(mapRunRow);
    });
  }

  /**
   * Runs every eval_case registered for `projectId` through the live answer
   * pipeline (AnswerService.answer) and scores each result:
   *  - refusalCorrect: does result.refused match the case's expectRefusal.
   *  - citationOk / substringOk: only meaningful for non-refusal cases (an
   *    expected-refusal case is scored purely on refusalCorrect; citationOk
   *    and substringOk are reported true/ignored for those).
   *  - pass = refusalCorrect && citationOk && substringOk.
   *
   * Persists an eval_runs row with the aggregate total/passed and the
   * per-case results array, and returns that same summary.
   */
  async run(schemaName: string, projectId: string): Promise<EvalRunSummary> {
    const cases = await this.list(schemaName, projectId);
    const results = await this.scoreCases(schemaName, projectId, cases);

    const total = results.length;
    const passed = results.filter((r) => r.pass).length;

    const runId = await this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(sql`
        INSERT INTO eval_runs (project_id, total, passed, results)
        VALUES (
          ${projectId},
          ${total},
          ${passed},
          ${JSON.stringify(results)}::jsonb
        )
        RETURNING id`);
      return (r.rows[0] as { id: string }).id;
    });

    return { runId, total, passed, results };
  }

  /**
   * Scores a batch of eval cases through the answer pipeline, optionally under
   * a set of `AnswerOverrides` (a prompt template and/or retrieval threshold —
   * feature #30's A/B experiment variants). This is the shared scoring core
   * extracted from `run`: `run` calls it with no overrides (unchanged
   * behavior), and the experiment runner calls it once per variant. It only
   * scores — it does NOT persist an `eval_runs` row.
   */
  async scoreCases(
    schemaName: string,
    projectId: string,
    cases: EvalCase[],
    overrides?: AnswerOverrides,
  ): Promise<EvalCaseResult[]> {
    const results: EvalCaseResult[] = [];
    for (const c of cases) {
      results.push(await this.scoreCase(schemaName, projectId, c, overrides));
    }
    return results;
  }

  /** Scores a single eval case (see `scoreCases`). */
  async scoreCase(
    schemaName: string,
    projectId: string,
    c: EvalCase,
    overrides?: AnswerOverrides,
  ): Promise<EvalCaseResult> {
    const answer = await this.answerService.answer(
      schemaName,
      projectId,
      c.question,
      // No conversation history in eval scoring; overrides carry the #30
      // experiment variant's prompt/threshold.
      [],
      overrides,
    );
    const refusalCorrect = answer.refused === c.expectRefusal;

    let citationOk = true;
    let substringOk = true;
    if (!c.expectRefusal) {
      citationOk =
        c.expectedSourceIds.length === 0
          ? true
          : c.expectedSourceIds.every((id) =>
              answer.citations.some((cit) => cit.sourceId === id),
            );
      substringOk =
        c.expectedSubstrings.length === 0
          ? true
          : c.expectedSubstrings.every((s) =>
              answer.answer.toLowerCase().includes(s.toLowerCase()),
            );
    }

    const pass = refusalCorrect && citationOk && substringOk;
    return {
      caseId: c.id,
      question: c.question,
      pass,
      refusalCorrect,
      citationOk,
      substringOk,
      refused: answer.refused,
    };
  }
}
