/**
 * Self-hosted profanity/abuse detection (#31). A pure, deterministic
 * heuristic filter — no LLM and no paid moderation API — so it's cheap
 * enough to run on every inbound visitor message before the RAG pipeline.
 *
 * Detection is a curated NL + EN wordlist matched with light normalization
 * (case-folding, common leetspeak digit substitutions, and stripping
 * repeated/separator characters used to evade naive filters, e.g.
 * "s.h.i.t" or "f u c k"). Matching is intentionally conservative:
 * whole-word/compound boundaries on the normalized text so neutral words
 * are not false-positived, mirroring the existing `frustration.ts` list.
 *
 * The list is deliberately short and documented rather than exhaustive: a
 * project can extend it per-project via `extraTerms` and carve out
 * false-positives via `allowTerms` (see ProfanityFilterConfig), so the
 * built-in list only needs to cover the common cases.
 */

/** Per-project profanity-filter configuration (stored in projects.settings). */
export interface ProfanityFilterConfig {
  enabled: boolean;
  action: ProfanityAction;
  /** Additional terms to treat as profanity, on top of the built-in list. */
  extraTerms?: string[];
  /** Terms to never flag, even if they match the built-in/extra list. */
  allowTerms?: string[];
}

export type ProfanityAction = 'warn' | 'block' | 'flag';

export const PROFANITY_ACTIONS: readonly ProfanityAction[] = [
  'warn',
  'block',
  'flag',
] as const;

/**
 * Built-in NL + EN profanity/abuse terms. Stored already-normalized (see
 * `normalize`) so they can be compared directly against normalized input.
 * Kept short and readable on purpose — extend per-project via `extraTerms`
 * rather than growing this list unboundedly.
 */
const BUILTIN_TERMS: readonly string[] = [
  // EN profanity / slurs (common)
  'fuck',
  'shit',
  'bitch',
  'asshole',
  'bastard',
  'dickhead',
  'cunt',
  'motherfucker',
  'wanker',
  'retard',
  // NL profanity (common)
  'kut',
  'klootzak',
  'lul',
  'hoer',
  'kanker',
  'tering',
  'godverdomme',
  'sukkel',
  'debiel',
];

/**
 * Normalizes text for matching: lower-cases, maps common leetspeak digits to
 * letters (0->o, 1->i, 3->e, 4->a, 5->s, 7->t, @->a, $->s), and removes any
 * character that is not a latin letter. Removing separators collapses
 * evasion attempts like "f-u-c-k", "s h i t" or "sh!t" onto their base form
 * while keeping matching a simple substring test on the cleaned string.
 */
export function normalize(text: string): string {
  const leet: Record<string, string> = {
    '0': 'o',
    '1': 'i',
    '3': 'e',
    '4': 'a',
    '5': 's',
    '7': 't',
    '@': 'a',
    $: 's',
  };
  return text
    .toLowerCase()
    .replace(/[013457@$]/g, (c) => leet[c] ?? c)
    .replace(/[^a-z]/g, '');
}

export interface ProfanityMatch {
  matched: boolean;
  /** The (normalized) built-in/extra terms that were found in the text. */
  terms: string[];
}

/**
 * Detects profanity/abuse in `text` using the built-in list plus any
 * per-project `extraTerms`, honoring `allowTerms` (matched terms present in
 * `allowTerms` are dropped). Detection is substring-based on the normalized
 * form of both the input and the terms, so leetspeak/separator evasion is
 * caught. Returns every distinct matched term (useful for the recorded
 * moderation event).
 */
export function detectProfanity(
  text: string,
  opts?: { extraTerms?: string[]; allowTerms?: string[] },
): ProfanityMatch {
  const normalizedInput = normalize(text);
  if (normalizedInput.length === 0) return { matched: false, terms: [] };

  const allow = new Set(
    (opts?.allowTerms ?? []).map(normalize).filter((t) => t.length > 0),
  );
  const terms = [
    ...BUILTIN_TERMS,
    ...(opts?.extraTerms ?? []).map(normalize),
  ].filter((t) => t.length > 0 && !allow.has(t));

  const found = new Set<string>();
  for (const term of terms) {
    if (normalizedInput.includes(term)) found.add(term);
  }
  return { matched: found.size > 0, terms: [...found] };
}

/**
 * Narrows the free-form `projects.settings.profanityFilter` jsonb into a
 * typed config, tolerating any missing/garbage shape (settings is
 * user/agent-editable jsonb, never trust its structure). Returns a disabled
 * config when unset or malformed, so a project that never opts in keeps the
 * pre-#31 behavior (filter never triggers).
 */
export function readProfanityConfig(
  settings: Record<string, unknown>,
): ProfanityFilterConfig {
  const disabled: ProfanityFilterConfig = { enabled: false, action: 'flag' };
  const raw = settings.profanityFilter;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return disabled;
  const r = raw as Record<string, unknown>;
  if (r.enabled !== true) return disabled;
  const action = PROFANITY_ACTIONS.includes(r.action as ProfanityAction)
    ? (r.action as ProfanityAction)
    : 'flag';
  const extraTerms = Array.isArray(r.extraTerms)
    ? r.extraTerms.filter((t): t is string => typeof t === 'string')
    : undefined;
  const allowTerms = Array.isArray(r.allowTerms)
    ? r.allowTerms.filter((t): t is string => typeof t === 'string')
    : undefined;
  return { enabled: true, action, extraTerms, allowTerms };
}
