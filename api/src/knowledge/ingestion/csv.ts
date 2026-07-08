/**
 * Minimal RFC-4180-ish CSV parser: handles quoted fields, escaped quotes
 * (""), commas and newlines inside quotes, and CRLF/LF line endings.
 */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  const pushField = (): void => {
    row.push(field);
    field = '';
  };
  const pushRow = (): void => {
    pushField();
    rows.push(row);
    row = [];
  };

  while (i < input.length) {
    const c = input[i];
    if (inQuotes) {
      if (c === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ',') {
      pushField();
      i++;
      continue;
    }
    if (c === '\r') {
      i++;
      continue;
    }
    if (c === '\n') {
      pushRow();
      i++;
      continue;
    }
    field += c;
    i++;
  }
  // Flush trailing field/row unless the input ended on a clean newline.
  if (field.length > 0 || row.length > 0) pushRow();
  return rows.filter((r) => r.some((f) => f.trim().length > 0));
}

export interface RawDocument {
  title: string;
  body: string;
  originUrl?: string;
  language?: string;
}

/**
 * Turns CSV text into raw documents. With a header row, `titleColumn` and
 * `bodyColumns` select fields by name; otherwise the first column is the title
 * and the rest form the body.
 */
export function csvToDocuments(
  csv: string,
  opts: { titleColumn?: string; bodyColumns?: string[] } = {},
): RawDocument[] {
  const rows = parseCsv(csv);
  if (rows.length === 0) return [];
  const header = rows[0];
  const dataRows = rows.slice(1);

  const titleIdx = opts.titleColumn ? header.indexOf(opts.titleColumn) : 0;
  const bodyIdxs = opts.bodyColumns
    ? opts.bodyColumns.map((c) => header.indexOf(c)).filter((n) => n >= 0)
    : header.map((_, n) => n).filter((n) => n !== titleIdx);

  return dataRows.map((r) => ({
    title: (r[titleIdx] ?? '').trim() || 'Untitled',
    body: bodyIdxs
      .map((n) => `${header[n]}: ${r[n] ?? ''}`)
      .join('\n')
      .trim(),
  }));
}
