/**
 * WCAG 2.x relative luminance / contrast ratio helpers.
 *
 * Formulas per https://www.w3.org/TR/WCAG21/#dfn-relative-luminance and
 * https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio. Pure math, no I/O — safe
 * to unit test directly and to call from request handlers without touching
 * the database.
 */

const HEX_RE = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/;

export function isValidHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_RE.test(value);
}

/** Expands e.g. `#abc` to `#aabbcc`; returns 6-hex (no `#`) input unchanged. */
function normalizeHex(hex: string): string {
  const body = hex.slice(1);
  if (body.length === 3) {
    return body
      .split('')
      .map((c) => c + c)
      .join('');
  }
  return body;
}

function srgbChannelToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Relative luminance (0..1) of a `#rrggbb`/`#rgb` hex color. */
export function relativeLuminance(hex: string): number {
  if (!HEX_RE.test(hex)) {
    throw new Error(`Invalid hex color: ${hex}`);
  }
  const normalized = normalizeHex(hex);
  const r = parseInt(normalized.slice(0, 2), 16);
  const g = parseInt(normalized.slice(2, 4), 16);
  const b = parseInt(normalized.slice(4, 6), 16);
  const [rl, gl, bl] = [r, g, b].map(srgbChannelToLinear);
  return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
}

/**
 * WCAG contrast ratio between two colors, in the range [1, 21]. Order of
 * arguments does not matter — the formula always divides the lighter
 * luminance by the darker one.
 */
export function contrastRatio(hexA: string, hexB: string): number {
  const la = relativeLuminance(hexA);
  const lb = relativeLuminance(hexB);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** WCAG AA thresholds. Large text (18pt+/14pt+bold) requires only 3:1. */
export const WCAG_AA_NORMAL_TEXT_MIN_RATIO = 4.5;
export const WCAG_AA_LARGE_TEXT_MIN_RATIO = 3;

export interface ContrastCheckResult {
  ratio: number;
  passesAA: boolean;
  passesAALarge: boolean;
}

export function checkContrast(
  foregroundHex: string,
  backgroundHex: string,
): ContrastCheckResult {
  const ratio = contrastRatio(foregroundHex, backgroundHex);
  return {
    ratio: Math.round(ratio * 100) / 100,
    passesAA: ratio >= WCAG_AA_NORMAL_TEXT_MIN_RATIO,
    passesAALarge: ratio >= WCAG_AA_LARGE_TEXT_MIN_RATIO,
  };
}
