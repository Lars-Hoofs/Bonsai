/**
 * Lightweight, dependency-free intent heuristics (#42).
 *
 * Bonsai is NL-first with EN as the second supported language, so this maps a
 * visitor question onto one of a small closed set of common support intents
 * using keyword/phrase matching per language. It is intentionally simple and
 * fully self-hosted (no NLP dependency, no paid API): each intent owns a set
 * of NL+EN trigger keywords, and the question is scored against every intent
 * by counting distinct keyword hits. The best-scoring intent wins; a question
 * that matches nothing is classified as `other`.
 *
 * This is the cheap, always-available classifier. The embedding-based
 * clusterer (see topic-cluster.ts) complements it by grouping the long tail of
 * `other` / novel questions the fixed ruleset can't name.
 */

export type IntentKey =
  | 'returns'
  | 'shipping'
  | 'payment'
  | 'order_status'
  | 'account'
  | 'product_info'
  | 'availability'
  | 'opening_hours'
  | 'complaint'
  | 'cancellation'
  | 'warranty'
  | 'contact'
  | 'other';

export interface IntentDefinition {
  key: IntentKey;
  /** Human-facing label (NL-first, EN in parentheses). */
  label: string;
  /**
   * Trigger keywords/phrases (lowercased). Multi-word phrases are matched as
   * substrings; single words are matched on token boundaries so `pay` does not
   * fire on `paypal`-unrelated noise. NL and EN triggers live together since a
   * single question is only ever one language.
   */
  keywords: string[];
}

/**
 * Ordered so that earlier definitions win ties (more specific / higher-value
 * support intents first). `other` is never in this list — it is the fallback.
 */
export const INTENT_DEFINITIONS: readonly IntentDefinition[] = [
  {
    key: 'returns',
    label: 'Retourneren (Returns)',
    keywords: [
      'retour',
      'retourneren',
      'terugsturen',
      'terugsturen',
      'ruilen',
      'return',
      'send back',
      'exchange',
      'refund',
      'terugbetaling',
      'geld terug',
    ],
  },
  {
    key: 'shipping',
    label: 'Verzending (Shipping)',
    // NL stems (matched as token prefixes): "verzend" covers verzenden/
    // verzending/verzendkosten, "bezorg" covers bezorgen/bezorging/bezorgd.
    // "levering"/"leveren" are kept explicit (not the "lever" stem) so they
    // don't bleed into availability's "leverbaar".
    keywords: [
      'verzend',
      'bezorg',
      'levering',
      'leveren',
      'shipping',
      'delivery',
      'deliver',
      'postnl',
      'dhl',
      'track and trace',
      'trackingnummer',
      'tracking',
    ],
  },
  {
    key: 'order_status',
    label: 'Bestelstatus (Order status)',
    keywords: [
      'waar is mijn bestelling',
      'bestelling status',
      'status bestelling',
      'order status',
      'where is my order',
      'mijn bestelling',
      'my order',
      'ordernummer',
      'order number',
    ],
  },
  {
    key: 'payment',
    label: 'Betaling (Payment)',
    keywords: [
      'betaling',
      'betalen',
      'betaald',
      'ideal',
      'creditcard',
      'factuur',
      'payment',
      'pay',
      'invoice',
      'paypal',
      'afrekenen',
      'checkout',
    ],
  },
  {
    key: 'cancellation',
    label: 'Annuleren (Cancellation)',
    keywords: [
      'annuleren',
      'annulering',
      'cancel',
      'cancellation',
      'stoppen',
      'opzeggen',
      'unsubscribe',
    ],
  },
  {
    key: 'account',
    label: 'Account',
    keywords: [
      'account',
      'inloggen',
      'wachtwoord',
      'password',
      'login',
      'log in',
      'sign in',
      'aanmelden',
      'registreren',
      'register',
      'e-mailadres wijzigen',
    ],
  },
  {
    key: 'availability',
    label: 'Beschikbaarheid (Availability)',
    keywords: [
      'voorraad',
      'op voorraad',
      'beschikbaar',
      'uitverkocht',
      'in stock',
      'stock',
      'available',
      'availability',
      'sold out',
      'wanneer weer leverbaar',
    ],
  },
  {
    // Placed before product_info: "garantie/warranty" is a more specific,
    // higher-value support signal than the generic "product" keyword, so it
    // should win ties (e.g. "garantie op dit product?").
    key: 'warranty',
    label: 'Garantie (Warranty)',
    keywords: [
      'garantie',
      'warranty',
      'guarantee',
      'defect',
      'kapot',
      'broken',
      'reparatie',
      'repair',
    ],
  },
  {
    key: 'product_info',
    label: 'Productinformatie (Product info)',
    keywords: [
      'product',
      'maat',
      'kleur',
      'materiaal',
      'afmeting',
      'specificatie',
      'size',
      'color',
      'colour',
      'material',
      'dimensions',
      'specification',
    ],
  },
  {
    key: 'opening_hours',
    label: 'Openingstijden (Opening hours)',
    keywords: [
      'openingstijden',
      'geopend',
      'open',
      'gesloten',
      'opening hours',
      'closed',
      'hoe laat',
      'what time',
    ],
  },
  {
    key: 'complaint',
    label: 'Klacht (Complaint)',
    keywords: [
      'klacht',
      'ontevreden',
      'slecht',
      'boos',
      'complaint',
      'unhappy',
      'disappointed',
      'terrible',
      'awful',
    ],
  },
  {
    key: 'contact',
    label: 'Contact',
    keywords: [
      'contact',
      'telefoonnummer',
      'bellen',
      'medewerker',
      'phone number',
      'call',
      'speak to',
      'human',
      'agent',
      'klantenservice',
      'customer service',
    ],
  },
];

export const OTHER_INTENT: IntentDefinition = {
  key: 'other',
  label: 'Overig (Other)',
  keywords: [],
};

const INTENT_LABELS: Record<IntentKey, string> = {
  ...Object.fromEntries(INTENT_DEFINITIONS.map((d) => [d.key, d.label])),
  other: OTHER_INTENT.label,
} as Record<IntentKey, string>;

export function intentLabel(key: IntentKey): string {
  return INTENT_LABELS[key];
}

const WORD_RE = /[\p{L}\p{N}]+/gu;

/**
 * Classify a single visitor question into an intent. Returns the winning key
 * plus the number of distinct keyword hits (0 for `other`), so callers can
 * gauge confidence and route weakly-matched questions to the clusterer.
 */
export function classifyIntent(text: string): {
  key: IntentKey;
  score: number;
} {
  const lower = text.toLowerCase();
  const tokens = lower.match(WORD_RE) ?? [];
  const tokenSet = new Set(tokens);

  let best: IntentKey = 'other';
  let bestScore = 0;

  for (const def of INTENT_DEFINITIONS) {
    let score = 0;
    for (const kw of def.keywords) {
      if (kw.includes(' ')) {
        // Phrase: substring match on the raw lowercased text.
        if (lower.includes(kw)) score++;
      } else if (tokenSet.has(kw)) {
        // Single word: exact token match.
        score++;
      } else if (kw.length >= 4 && tokens.some((t) => t.startsWith(kw))) {
        // Morphological variant: a token that starts with the keyword stem
        // (e.g. "delivered" for "deliver", "betaald" for "betaal"). Only for
        // keywords of length >=4 so short stems don't cause partial-word
        // false hits.
        score++;
      }
    }
    // Strictly-greater keeps INTENT_DEFINITIONS order as the tie-breaker, so
    // more specific/high-value intents earlier in the list win ties.
    if (score > bestScore) {
      bestScore = score;
      best = def.key;
    }
  }

  return { key: best, score: bestScore };
}
