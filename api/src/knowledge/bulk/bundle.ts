import { parseCsv } from '../ingestion/csv';
import { buildZip, parseZip, ZipEntry } from './zip';

/**
 * A single knowledge-base entry in a bulk bundle. This is the manual-KB
 * "row" unit: a title + body (+ optional language) that, on import, becomes a
 * `manual` knowledge source and is run through the normal ingestion pipeline
 * (chunk -> embed -> index). Export reconstructs these from the stored config
 * of manual/upload/csv-derived sources.
 */
export interface KbEntry {
  title: string;
  body: string;
  language?: string;
}

export type BundleFormat = 'json' | 'csv' | 'zip';

export const MANUAL_TITLE_MAX = 200;
export const MANUAL_BODY_MAX = 200_000;
const LANGUAGE_MIN = 2;
const LANGUAGE_MAX = 8;

/** A per-row validation problem, reported back to the caller on import. */
export interface RowError {
  /** 0-based index of the entry within the bundle. */
  row: number;
  message: string;
}

export interface ParsedBundle {
  entries: KbEntry[];
  /** Rows that failed structural validation; excluded from `entries`. */
  errors: RowError[];
}

// --- Export ----------------------------------------------------------------

function escapeCsvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function entriesToCsv(entries: KbEntry[]): string {
  const lines = ['title,body,language'];
  for (const e of entries) {
    lines.push(
      [e.title, e.body, e.language ?? ''].map(escapeCsvField).join(','),
    );
  }
  return lines.join('\r\n') + '\r\n';
}

export function entriesToJson(entries: KbEntry[]): string {
  return JSON.stringify({ version: 1, entries }, null, 2);
}

/** Slugifies a title into a filesystem-safe base name for a Markdown file. */
function slugify(title: string, fallback: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || fallback;
}

/** Serializes one entry as a Markdown file with a small YAML front-matter
 * block carrying the structured fields, so it round-trips losslessly. */
export function entryToMarkdown(entry: KbEntry): string {
  const fm = [`---`, `title: ${JSON.stringify(entry.title)}`];
  if (entry.language) fm.push(`language: ${JSON.stringify(entry.language)}`);
  fm.push(`---`, '');
  return fm.join('\n') + entry.body + '\n';
}

/** Builds the Markdown-zip bundle: one `NNNN-slug.md` per entry plus a
 * `manifest.json` (the same JSON export) for lossless machine round-trip. */
export function entriesToMarkdownZip(entries: KbEntry[]): Buffer {
  const files: ZipEntry[] = entries.map((e, i) => {
    const num = String(i + 1).padStart(4, '0');
    return {
      name: `entries/${num}-${slugify(e.title, num)}.md`,
      content: Buffer.from(entryToMarkdown(e), 'utf8'),
    };
  });
  files.push({
    name: 'manifest.json',
    content: Buffer.from(entriesToJson(entries), 'utf8'),
  });
  return buildZip(files);
}

// --- Import ----------------------------------------------------------------

/** Structurally validates one raw entry, returning a clean KbEntry or an
 * error message. Trims title; empty title or body is rejected. */
function validateEntry(raw: {
  title?: unknown;
  body?: unknown;
  language?: unknown;
}): { entry: KbEntry } | { error: string } {
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const body = typeof raw.body === 'string' ? raw.body : '';
  if (!title) return { error: 'title is verplicht' };
  if (title.length > MANUAL_TITLE_MAX) {
    return { error: `title mag maximaal ${MANUAL_TITLE_MAX} tekens zijn` };
  }
  if (!body.trim()) return { error: 'body is verplicht' };
  if (body.length > MANUAL_BODY_MAX) {
    return { error: `body mag maximaal ${MANUAL_BODY_MAX} tekens zijn` };
  }
  let language: string | undefined;
  if (
    raw.language !== undefined &&
    raw.language !== null &&
    raw.language !== ''
  ) {
    if (typeof raw.language !== 'string') {
      return { error: 'language moet een string zijn' };
    }
    if (
      raw.language.length < LANGUAGE_MIN ||
      raw.language.length > LANGUAGE_MAX
    ) {
      return {
        error: `language moet tussen ${LANGUAGE_MIN} en ${LANGUAGE_MAX} tekens zijn`,
      };
    }
    language = raw.language;
  }
  return { entry: { title, body, ...(language ? { language } : {}) } };
}

function collect(rawEntries: unknown[]): ParsedBundle {
  const entries: KbEntry[] = [];
  const errors: RowError[] = [];
  rawEntries.forEach((raw, row) => {
    if (typeof raw !== 'object' || raw === null) {
      errors.push({ row, message: 'ongeldige rij (geen object)' });
      return;
    }
    const result = validateEntry(raw);
    if ('error' in result) {
      errors.push({ row, message: result.error });
    } else {
      entries.push(result.entry);
    }
  });
  return { entries, errors };
}

export function parseJsonBundle(text: string): ParsedBundle {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Ongeldige JSON');
  }
  const rawEntries = Array.isArray(data)
    ? data
    : Array.isArray((data as { entries?: unknown }).entries)
      ? (data as { entries: unknown[] }).entries
      : null;
  if (!rawEntries) {
    throw new Error('JSON moet een array van entries of {entries:[...]} zijn');
  }
  return collect(rawEntries);
}

export function parseCsvBundle(text: string): ParsedBundle {
  const rows = parseCsv(text);
  if (rows.length === 0) return { entries: [], errors: [] };
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const titleIdx = header.indexOf('title');
  const bodyIdx = header.indexOf('body');
  const langIdx = header.indexOf('language');
  if (titleIdx < 0 || bodyIdx < 0) {
    throw new Error('CSV-header moet "title" en "body" kolommen bevatten');
  }
  const raws = rows.slice(1).map((r) => ({
    title: r[titleIdx],
    body: r[bodyIdx],
    language: langIdx >= 0 ? r[langIdx] : undefined,
  }));
  return collect(raws);
}

/** Parses a KB Markdown-zip bundle. Prefers the machine-readable
 * `manifest.json` when present (lossless round-trip); otherwise reconstructs
 * entries from the individual `.md` files (front-matter title/language +
 * remaining body). */
export function parseZipBundle(buf: Buffer): ParsedBundle {
  const files = parseZip(buf);
  const manifest = files.find((f) => f.name === 'manifest.json');
  if (manifest) {
    return parseJsonBundle(manifest.content.toString('utf8'));
  }
  const mdFiles = files
    .filter((f) => f.name.toLowerCase().endsWith('.md'))
    .sort((a, b) => a.name.localeCompare(b.name));
  const raws = mdFiles.map((f) => parseMarkdown(f.content.toString('utf8')));
  return collect(raws);
}

/** Parses a single Markdown file's optional YAML-ish front matter and body. */
function parseMarkdown(text: string): {
  title?: string;
  body: string;
  language?: string;
} {
  const fmMatch = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!fmMatch) {
    // No front matter: first non-empty line is the title (strip leading #).
    const lines = text.split('\n');
    const title = (lines[0] ?? '').replace(/^#+\s*/, '').trim();
    return { title, body: lines.slice(1).join('\n').trim() };
  }
  const meta: Record<string, string> = {};
  for (const line of fmMatch[1].split('\n')) {
    const m = /^(\w+):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    let value = m[2].trim();
    if (value.startsWith('"')) {
      try {
        value = JSON.parse(value) as string;
      } catch {
        /* leave as-is */
      }
    }
    meta[m[1]] = value;
  }
  const body = text.slice(fmMatch[0].length).trim();
  return { title: meta.title, body, language: meta.language };
}

export function parseBundle(format: BundleFormat, data: Buffer): ParsedBundle {
  if (format === 'zip') return parseZipBundle(data);
  const text = data.toString('utf8');
  if (format === 'csv') return parseCsvBundle(text);
  return parseJsonBundle(text);
}
