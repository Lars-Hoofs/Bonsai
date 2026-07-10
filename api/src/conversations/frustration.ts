/**
 * Frustration/sentiment auto-escalation heuristics (#24). Pure, deterministic
 * helpers — no LLM call — so they're cheap enough to run on every visitor
 * message. Matching is intentionally conservative (whole-phrase/word
 * patterns, not single ambiguous keywords) to avoid false-positiving on
 * neutral questions like "wat zijn de openingstijden".
 */

/**
 * Phrases (NL + EN) that explicitly ask to talk to a human instead of the
 * bot. Matched as regexes so small wording variations ("ik wil graag een
 * medewerker spreken") still hit, but generic words like "mens" or "persoon"
 * alone are never enough — they must appear in one of these human-contact
 * patterns.
 */
const HUMAN_REQUEST_PATTERNS: RegExp[] = [
  // NL: "ik wil een/graag ... medewerker/mens/persoon (spreken/praten)"
  /\bmedewerker\b/i,
  /\b(met|naar)\s+(een\s+)?(mens|persoon)\b/i,
  /\b(een\s+)?(mens|persoon)\s+(spreken|praten)\b/i,
  /\bmet\s+iemand\s+(praten|spreken)\b/i,
  /\bgeen\s+bot\b/i,
  /\becht\s+persoon\b/i,
  // EN: "talk/speak to a/an human/agent/real person", "connect me with ..."
  /\b(talk|speak|chat)\s+(to|with)\s+(a|an)?\s*(human|agent|real\s+person|person)\b/i,
  /\breal\s+person\b/i,
  /\bconnect\s+me\s+(with|to)\s+(a|an)?\s*(human|agent|real\s+person|person)\b/i,
  /\bhuman\s+agent\b/i,
];

/**
 * Small, curated NL + EN negativity/profanity list. Deliberately short and
 * documented (rather than a generic sentiment model) so behavior stays
 * predictable and easy to extend. Matched as whole-word/phrase boundaries to
 * avoid substring false positives (e.g. "kutschaar" containing "kut" is still
 * a match by design — Dutch profanity commonly compounds — but "nikkel"
 * should not match "niks").
 */
const NEGATIVE_PATTERNS: RegExp[] = [
  // NL negativity / profanity
  /\bbelachelijk\b/i,
  /\bwaardeloos\w*\b/i,
  /\bwaardeloze\w*\b/i,
  /\bkut\w*\b/i,
  /\bniks\s+aan\b/i,
  /\bslecht\b/i,
  /\bklote\w*\b/i,
  /\bstom\b/i,
  /\birritant\b/i,
  /\bonzin\b/i,
  // EN negativity / profanity
  /\buseless\b/i,
  /\bterrible\b/i,
  /\bridiculous\b/i,
  /\bstupid\b/i,
  /\bpathetic\b/i,
  /\bawful\b/i,
  /\bgarbage\b/i,
  /\bcrap\b/i,
];

/**
 * True when `text` explicitly asks for a human instead of the bot, in NL or
 * EN, case-insensitively.
 */
export function explicitHumanRequest(text: string): boolean {
  return HUMAN_REQUEST_PATTERNS.some((re) => re.test(text));
}

/**
 * True when `text` contains a curated negativity/profanity phrase, in NL or
 * EN, case-insensitively.
 */
export function negativeSentiment(text: string): boolean {
  return NEGATIVE_PATTERNS.some((re) => re.test(text));
}

export interface FrustrationSignal {
  latestVisitorText: string;
  consecutiveRefusals: number;
  refusalStreakThreshold: number;
}

/**
 * Combines all three frustration signals: an explicit ask for a human, a
 * negative/frustrated message, or a run of consecutive bot refusals meeting
 * or exceeding the configured streak threshold.
 */
export function isFrustrated(signal: FrustrationSignal): boolean {
  return (
    explicitHumanRequest(signal.latestVisitorText) ||
    negativeSentiment(signal.latestVisitorText) ||
    signal.consecutiveRefusals >= signal.refusalStreakThreshold
  );
}
