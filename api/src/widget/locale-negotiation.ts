import { normalizeLocale } from './copy-validation';

/**
 * Parses an HTTP `Accept-Language` header into an ordered list of normalized
 * (lowercased) locale tags, most-preferred first, honoring q-weights. Invalid
 * or malformed entries (and the `*` wildcard) are dropped rather than throwing
 * — this is untrusted visitor input on the public config endpoint.
 */
export function parseAcceptLanguage(header: string | undefined): string[] {
  if (!header) return [];
  return header
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      let q = 1;
      for (const p of params) {
        const m = /^q=([0-9.]+)$/.exec(p.trim());
        if (m) q = Number.parseFloat(m[1]);
      }
      return { tag: tag.trim().toLowerCase(), q: Number.isFinite(q) ? q : 0 };
    })
    .filter((e) => e.tag && e.tag !== '*' && e.q > 0)
    .sort((a, b) => b.q - a.q)
    .map((e) => e.tag);
}

/**
 * Negotiates the copy to serve for a requested locale against the available
 * locales, falling back to the project's default locale, then to any
 * available locale.
 *
 * Resolution order for each candidate (explicit `?locale=` first, then each
 * `Accept-Language` preference, then `defaultLocale`):
 *   1. exact match on a candidate tag (e.g. `en-us`)
 *   2. primary-subtag match (e.g. `en-us` -> `en`)
 * The first candidate that resolves wins. If nothing matches, the default
 * locale's copy is returned if present, else the first available locale.
 *
 * Returns `{ locale, copy }` for the chosen locale, or `null` when there is no
 * copy at all.
 */
export function negotiateCopy(
  available: Record<string, Record<string, string>>,
  requested: string[],
  defaultLocale: string,
): { locale: string; copy: Record<string, string> } | null {
  const keys = Object.keys(available);
  if (keys.length === 0) return null;

  const resolve = (tag: string): string | undefined => {
    if (available[tag]) return tag;
    const primary = tag.split('-')[0];
    if (available[primary]) return primary;
    // Also allow matching a bare requested tag against a regional available
    // one, e.g. requested `en` matching available `en-us`.
    const prefixed = keys.find((k) => k.split('-')[0] === primary);
    return prefixed;
  };

  const candidates = [...requested, defaultLocale];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const match = resolve(candidate.toLowerCase());
    if (match) return { locale: match, copy: available[match] };
  }

  // Last resort: default locale if present, else the first available locale.
  const fallback = available[defaultLocale] ? defaultLocale : keys[0];
  return { locale: fallback, copy: available[fallback] };
}

/** Re-exported for callers that only need to validate a `?locale=` value. */
export { normalizeLocale };
