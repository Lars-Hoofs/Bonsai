import { BadRequestException } from '@nestjs/common';

/**
 * Per-type structural validation for `CreateSourceDto.config`, applied at
 * source-creation time. This is purely structural/size bounding (to stop a
 * huge or malformed payload from driving unbounded ingestion cost) — it does
 * NOT perform SSRF/DNS checks for `website` URLs; that already happens
 * later, at fetch time, via `safeFetch`/`assertPublicHttpUrl`.
 */

const MANUAL_TITLE_MAX = 200;
const MANUAL_BODY_MAX = 200_000;
const LANGUAGE_MIN = 2;
const LANGUAGE_MAX = 8;
const WEBSITE_URL_MAX = 2048;
const CSV_MAX = 1_000_000;
const CSV_COLUMN_ARRAY_MAX = 50;

export const WEBSITE_CRAWL_DEFAULT_MAX_PAGES = 50;
export const WEBSITE_CRAWL_MAX_PAGES_CAP = 200;
export const WEBSITE_CRAWL_DEFAULT_MAX_DEPTH = 2;
export const WEBSITE_CRAWL_MAX_DEPTH_CAP = 5;

function requireString(
  value: unknown,
  field: string,
  maxLen: number,
): asserts value is string {
  if (typeof value !== 'string') {
    throw new BadRequestException(`config.${field} must be a string`);
  }
  if (value.length > maxLen) {
    throw new BadRequestException(
      `config.${field} must be at most ${maxLen} characters`,
    );
  }
}

function validateManualConfig(config: Record<string, unknown>): void {
  requireString(config.title, 'title', MANUAL_TITLE_MAX);
  requireString(config.body, 'body', MANUAL_BODY_MAX);
  if (config.language !== undefined) {
    requireString(config.language, 'language', LANGUAGE_MAX);
    if (config.language.length < LANGUAGE_MIN) {
      throw new BadRequestException(
        `config.language must be at least ${LANGUAGE_MIN} characters`,
      );
    }
  }
}

function requireBoundedInt(
  value: unknown,
  field: string,
  max: number,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new BadRequestException(`config.${field} must be an integer`);
  }
  if (value < 1) {
    throw new BadRequestException(`config.${field} must be at least 1`);
  }
  if (value > max) {
    throw new BadRequestException(`config.${field} must be at most ${max}`);
  }
}

function validateWebsiteConfig(config: Record<string, unknown>): void {
  requireString(config.url, 'url', WEBSITE_URL_MAX);
  let parsed: URL;
  try {
    parsed = new URL(config.url);
  } catch {
    throw new BadRequestException('config.url must be a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BadRequestException(
      'config.url must use the http or https scheme',
    );
  }
  if (config.crawl !== undefined && typeof config.crawl !== 'boolean') {
    throw new BadRequestException('config.crawl must be a boolean');
  }
  if (config.maxPages !== undefined) {
    requireBoundedInt(config.maxPages, 'maxPages', WEBSITE_CRAWL_MAX_PAGES_CAP);
  }
  if (config.maxDepth !== undefined) {
    requireBoundedInt(config.maxDepth, 'maxDepth', WEBSITE_CRAWL_MAX_DEPTH_CAP);
  }
}

function requireStringArray(
  value: unknown,
  field: string,
  maxEntries: number,
): void {
  if (!Array.isArray(value)) {
    throw new BadRequestException(`config.${field} must be an array`);
  }
  if (value.length > maxEntries) {
    throw new BadRequestException(
      `config.${field} must have at most ${maxEntries} entries`,
    );
  }
  if (!value.every((v) => typeof v === 'string')) {
    throw new BadRequestException(
      `config.${field} must be an array of strings`,
    );
  }
}

function validateCsvConfig(config: Record<string, unknown>): void {
  requireString(config.csv, 'csv', CSV_MAX);
  if (config.titleColumn !== undefined) {
    requireString(config.titleColumn, 'titleColumn', 200);
  }
  if (config.bodyColumns !== undefined) {
    requireStringArray(config.bodyColumns, 'bodyColumns', CSV_COLUMN_ARRAY_MAX);
  }
}

/**
 * Validates `config` against the shape expected for `type`. Throws
 * `BadRequestException` with a clear message on any violation.
 *
 * `type` values not explicitly handled here (e.g. `upload`, which is
 * populated server-side from already-extracted text rather than raw client
 * input, or any future source type) are intentionally left unvalidated by
 * this function so as not to break existing/future functionality — callers
 * that need bounds for those types should add them explicitly.
 */
export function validateSourceConfig(
  type: string,
  config: Record<string, unknown>,
): void {
  if (type === 'manual') {
    validateManualConfig(config);
    return;
  }
  if (type === 'website') {
    validateWebsiteConfig(config);
    return;
  }
  if (type === 'csv') {
    validateCsvConfig(config);
    return;
  }
  // Unknown/other types (e.g. 'upload'): no strict validation here.
}
