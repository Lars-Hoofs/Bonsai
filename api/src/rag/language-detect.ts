/**
 * Dependency-free NL/EN language heuristic for the visitor's question (A10).
 *
 * Bonsai is NL-first, so this only needs to distinguish Dutch from English
 * (the spec's minimum-supported pair) and MUST default to `'nl'` whenever the
 * signal is weak or tied, rather than guessing `'en'`.
 *
 * Approach: tokenize on word boundaries, lowercase, and count how many
 * tokens are in a small closed-class stopword list per language (function
 * words: articles, pronouns, common auxiliaries/prepositions). These words
 * are both extremely frequent and near-disjoint between the two languages,
 * which makes them a robust, cheap signal for short visitor questions
 * without pulling in any NLP dependency. Dutch-specific digraphs/diacritics
 * (ij, ë, "aa"/"ee"/"oo" doubled vowels mid-word) add a small extra nl-only
 * signal for short inputs that dodge the stopword lists entirely.
 */
export function detectLanguage(text: string): 'nl' | 'en' {
  const tokens = text.toLowerCase().match(/[a-zà-ÿ]+/g);
  if (!tokens || tokens.length === 0) {
    return 'nl';
  }

  let nlScore = 0;
  let enScore = 0;
  for (const token of tokens) {
    if (NL_STOPWORDS.has(token)) nlScore++;
    if (EN_STOPWORDS.has(token)) enScore++;
  }

  // Extra weak signal from characteristic Dutch spelling, useful when a
  // short question has few/no stopword hits either way.
  if (/ij|[ëï]|aa|ee|oo|uu/.test(text.toLowerCase())) {
    nlScore += 0.5;
  }

  // NL-first default: English only wins on a STRICT majority.
  return enScore > nlScore ? 'en' : 'nl';
}

const NL_STOPWORDS = new Set([
  'de',
  'het',
  'een',
  'en',
  'van',
  'ik',
  'jij',
  'je',
  'u',
  'wij',
  'we',
  'zij',
  'ze',
  'is',
  'zijn',
  'was',
  'waren',
  'wat',
  'welke',
  'wie',
  'hoe',
  'waarom',
  'wanneer',
  'waar',
  'kan',
  'kun',
  'kunt',
  'wil',
  'wilt',
  'graag',
  'mijn',
  'jouw',
  'uw',
  'zijn',
  'haar',
  'onze',
  'deze',
  'die',
  'dit',
  'dat',
  'niet',
  'geen',
  'met',
  'voor',
  'naar',
  'over',
  'onder',
  'tot',
  'ook',
  'nog',
  'maar',
  'of',
  'als',
  'dan',
  'op',
  'in',
  'aan',
  'bij',
  'uit',
  'winkel',
  'openingstijden',
  'vandaag',
  'morgen',
  'gisteren',
  'alstublieft',
  'bestelling',
  'weten',
]);

const EN_STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'of',
  'i',
  'you',
  'he',
  'she',
  'we',
  'they',
  'is',
  'are',
  'was',
  'were',
  'what',
  'which',
  'who',
  'how',
  'why',
  'when',
  'where',
  'can',
  'could',
  'would',
  'please',
  'my',
  'your',
  'his',
  'her',
  'our',
  'this',
  'that',
  'these',
  'those',
  'not',
  'no',
  'with',
  'for',
  'to',
  'about',
  'under',
  'until',
  'also',
  'still',
  'but',
  'or',
  'if',
  'than',
  'on',
  'in',
  'at',
  'by',
  'out',
  'today',
  'tomorrow',
  'yesterday',
  'order',
  'hours',
  'opening',
  'tell',
  'me',
  'is',
]);
