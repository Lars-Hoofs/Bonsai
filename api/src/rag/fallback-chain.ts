/**
 * Configurable fallback chain (#29): KB -> connector -> human.
 *
 * A project can configure, via `projects.settings.fallbackChain`, an ORDERED
 * list of the stages the answer pipeline should try before giving up on a
 * question:
 *   - `kb`        — knowledge-base retrieval (the grounded RAG answer);
 *   - `connector` — a live tenant-configured connector/tool call
 *                   (see ConnectorToolService) supplying a citable live source;
 *   - `human`     — hand the visitor over to a human agent (surfaced as
 *                   `AnswerResult.escalationSuggested`, which the conversations
 *                   layer turns into a real handover/escalation).
 *
 * This module is a small, pure, dependency-free interpreter of that config.
 * It does NOT change how any individual stage works — it only decides, from
 * the configured order, WHICH stages the existing `AnswerService.answer()`
 * flow engages and whether an unresolved question ends in a human handover.
 *
 * Backward compatibility: when a project has no `fallbackChain` configured
 * (the default), `resolveFallbackChain` returns the DEFAULT chain
 * `['kb', 'connector', 'human']`, which reproduces today's behavior exactly —
 * KB retrieval + confidence gate, opportunistic connector tool-calling, and a
 * human-handover suggestion on refusal. The setting is therefore purely
 * additive and opt-in.
 */

/** The stages a fallback chain can be composed of, in the order a project
 * lists them. */
export type FallbackStage = 'kb' | 'connector' | 'human';

/** Every stage type, for validation. */
export const FALLBACK_STAGES: readonly FallbackStage[] = [
  'kb',
  'connector',
  'human',
] as const;

/** The chain applied when a project has not configured one — identical to the
 * pre-#29 hard-coded behavior (KB, then opportunistic connector, then human
 * handover on refusal). */
export const DEFAULT_FALLBACK_CHAIN: readonly FallbackStage[] = [
  'kb',
  'connector',
  'human',
] as const;

/** A resolved, deduplicated, order-preserving view of a project's fallback
 * chain, with cheap membership/order queries the answer flow needs. */
export interface ResolvedFallbackChain {
  /** The ordered, deduplicated stages. */
  readonly stages: readonly FallbackStage[];
  /** Whether the chain includes a KB retrieval stage. */
  readonly usesKb: boolean;
  /** Whether the chain includes a live-connector stage. */
  readonly usesConnector: boolean;
  /** Whether the chain ends an unresolved question in a human handover. */
  readonly usesHuman: boolean;
}

/**
 * Reads and normalizes a project's `settings.fallbackChain` into a
 * `ResolvedFallbackChain`. Tolerant/best-effort by design (mirrors how
 * `AnswerService.loadProject` reads `confidenceThreshold`): any missing,
 * malformed, or empty value falls back to `DEFAULT_FALLBACK_CHAIN` so a bad
 * write can never break answering. Validation of writes is enforced
 * separately, on the settings-management PATCH path (see
 * `settings-validation.ts`).
 *
 * Accepts two shapes for each element (both validated on write):
 *   - a plain stage string, e.g. `"kb"`;
 *   - an object `{ type: "kb" }` (room for future per-stage options).
 * Unknown stage values are dropped; duplicates keep their first occurrence.
 * If nothing valid remains, the default chain is used.
 */
export function resolveFallbackChain(
  settings: Record<string, unknown> | null | undefined,
): ResolvedFallbackChain {
  const raw = settings?.fallbackChain;
  const stages = raw === undefined ? null : normalizeChain(raw);
  const effective =
    stages && stages.length > 0 ? stages : [...DEFAULT_FALLBACK_CHAIN];
  return {
    stages: effective,
    usesKb: effective.includes('kb'),
    usesConnector: effective.includes('connector'),
    usesHuman: effective.includes('human'),
  };
}

/**
 * Best-effort normalization of an arbitrary stored `fallbackChain` value into
 * a deduplicated list of valid stages, preserving first-occurrence order.
 * Returns `null` when the input is not an array (so the caller uses the
 * default), and an empty array when it is an array with no valid stages left.
 */
function normalizeChain(raw: unknown): FallbackStage[] | null {
  if (!Array.isArray(raw)) return null;
  const out: FallbackStage[] = [];
  for (const entry of raw) {
    const stage = coerceStage(entry);
    if (stage && !out.includes(stage)) out.push(stage);
  }
  return out;
}

/** Coerces a single chain element (string or `{ type }` object) to a valid
 * `FallbackStage`, or `null` if it is neither. */
function coerceStage(entry: unknown): FallbackStage | null {
  const value =
    typeof entry === 'string'
      ? entry
      : typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as { type?: unknown }).type === 'string'
        ? (entry as { type: string }).type
        : undefined;
  return isFallbackStage(value) ? value : null;
}

/** Type guard for a valid fallback stage string. */
export function isFallbackStage(value: unknown): value is FallbackStage {
  return (
    typeof value === 'string' &&
    (FALLBACK_STAGES as readonly string[]).includes(value)
  );
}
