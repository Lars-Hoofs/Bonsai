import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { TenantDbService } from '../tenancy/tenant-db.service';
import { APP_CONFIG } from '../config/config';
import type { AppConfig } from '../config/config';
import { RetrievalService } from './retrieval.service';
import { LLM_PROVIDER } from './llm-provider';
import type { LlmMessage, LlmProvider } from './llm-provider';

export interface Citation {
  index: number;
  chunkId: string;
  documentId: string;
  documentTitle: string;
  sourceId: string;
  originUrl: string | null;
}

export interface AnswerResult {
  answer: string;
  confidence: number;
  refused: boolean;
  citations: Citation[];
  escalationSuggested: boolean;
}

const DEFAULT_THRESHOLD = 0.25;
const REFUSAL_NL =
  'Dat weet ik niet zeker op basis van de beschikbare informatie. ' +
  'Ik verbind je graag door met een medewerker.';

@Injectable()
export class AnswerService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly retrieval: RetrievalService,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  async answer(
    schemaName: string,
    projectId: string,
    question: string,
  ): Promise<AnswerResult> {
    const project = await this.loadProject(schemaName, projectId);
    const threshold = project.confidenceThreshold;

    const chunks = await this.retrieval.retrieve(
      schemaName,
      projectId,
      question,
      {
        language: project.language,
      },
    );
    const confidence =
      chunks.length === 0
        ? 0
        : Math.max(
            0,
            Math.min(1, Math.max(...chunks.map((c) => c.similarity))),
          );

    // Confidence gate: below the (per-project) threshold we do NOT guess.
    if (chunks.length === 0 || confidence < threshold) {
      return {
        answer: REFUSAL_NL,
        confidence,
        refused: true,
        citations: [],
        escalationSuggested: true,
      };
    }

    const messages = this.buildPrompt(question, chunks);
    const raw = await this.llm.complete(messages, { temperature: 0.1 });

    // Citation enforcement: the answer must reference at least one provided
    // source [n]; an uncited answer is treated as ungrounded and refused.
    const cited = this.parseCitations(raw, chunks);
    if (cited.length === 0) {
      return {
        answer: REFUSAL_NL,
        confidence,
        refused: true,
        citations: [],
        escalationSuggested: true,
      };
    }

    // Second-pass groundedness self-check: an independent model call decides
    // whether the drafted answer is fully supported by the sources. If not, we
    // refuse rather than risk a plausible-but-unsupported answer.
    if (this.cfg.selfCheckEnabled && !(await this.selfCheck(raw, chunks))) {
      return {
        answer: REFUSAL_NL,
        confidence,
        refused: true,
        citations: [],
        escalationSuggested: true,
      };
    }

    return {
      answer: raw.trim(),
      confidence,
      refused: false,
      citations: cited,
      escalationSuggested: false,
    };
  }

  /** Returns true if an independent model call judges the answer fully grounded. */
  private async selfCheck(
    answer: string,
    chunks: { text: string; documentTitle: string }[],
  ): Promise<boolean> {
    const sources = chunks
      .map((c, i) => `[${i + 1}] ${c.documentTitle}: ${c.text}`)
      .join('\n\n');
    const messages: LlmMessage[] = [
      {
        role: 'system',
        content:
          '[[VERIFY]] Je bent een strenge controleur. Bepaal of het ANTWOORD ' +
          'volledig wordt gedekt door de BRONNEN. Antwoord met exact JSON: ' +
          '{"supported": true} of {"supported": false}. supported=false bij ' +
          'elke bewering die niet in de bronnen staat.',
      },
      { role: 'user', content: `ANTWOORD:\n${answer}\n\nBRONNEN:\n${sources}` },
    ];
    const verdict = await this.llm.complete(messages, { temperature: 0 });
    return /"?supported"?\s*:?\s*true/i.test(verdict);
  }

  private buildPrompt(
    question: string,
    chunks: { text: string; documentTitle: string }[],
  ): LlmMessage[] {
    const sources = chunks
      .map((c, i) => `[${i + 1}] ${c.documentTitle}: ${c.text}`)
      .join('\n\n');
    const system =
      'Je bent een klantenservice-assistent. Beantwoord de vraag UITSLUITEND op ' +
      'basis van de genummerde bronnen hieronder. Verzin niets. Als het antwoord ' +
      'niet in de bronnen staat, zeg dan eerlijk dat je het niet zeker weet. ' +
      'Verwijs naar de gebruikte bronnen met [n].';
    const user = `Vraag: ${question}\n\nBronnen:\n${sources}`;
    return [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
  }

  private parseCitations(
    answer: string,
    chunks: Array<{
      chunkId: string;
      documentId: string;
      documentTitle: string;
      sourceId: string;
      originUrl: string | null;
    }>,
  ): Citation[] {
    const indices = new Set<number>();
    for (const m of answer.matchAll(/\[(\d+)\]/g)) {
      const n = Number(m[1]);
      if (n >= 1 && n <= chunks.length) indices.add(n);
    }
    return [...indices]
      .sort((a, b) => a - b)
      .map((n) => {
        const c = chunks[n - 1];
        return {
          index: n,
          chunkId: c.chunkId,
          documentId: c.documentId,
          documentTitle: c.documentTitle,
          sourceId: c.sourceId,
          originUrl: c.originUrl,
        };
      });
  }

  private async loadProject(
    schemaName: string,
    projectId: string,
  ): Promise<{ language: string; confidenceThreshold: number }> {
    return this.tenantDb.withTenant(schemaName, async (db) => {
      const r = await db.execute(
        sql`SELECT default_language, settings FROM projects WHERE id = ${projectId}`,
      );
      const row = r.rows[0] as
        | { default_language: string; settings: Record<string, unknown> }
        | undefined;
      const settings = row?.settings ?? {};
      const raw = settings.confidenceThreshold;
      const threshold =
        typeof raw === 'number' && raw >= 0 && raw <= 1
          ? raw
          : DEFAULT_THRESHOLD;
      return {
        language: row?.default_language ?? 'nl',
        confidenceThreshold: threshold,
      };
    });
  }
}
