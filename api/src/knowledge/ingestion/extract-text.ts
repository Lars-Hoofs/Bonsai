/**
 * Converts HTML to readable plain text: drops script/style, turns block tags
 * into newlines, strips remaining tags, decodes a few common entities, and
 * collapses whitespace. Good enough for knowledge ingestion (not a renderer).
 */
export function htmlToText(html: string): string {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const withBreaks = withoutScripts
    .replace(/<\/(p|div|section|article|li|h[1-6]|br|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n');
  const noTags = withBreaks.replace(/<[^>]+>/g, ' ');
  const decoded = noTags
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  return decoded
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .trim();
}

export function extractTitle(html: string, fallback: string): string {
  const m = /<title>([\s\S]*?)<\/title>/i.exec(html);
  const title = m ? m[1].trim() : '';
  return title.length > 0 ? title : fallback;
}

// Binary formats (pdf, docx) are parsed by third-party libraries running
// against arbitrary attacker-supplied bytes, so we bound the work they can
// do: cap the number of PDF pages parsed, cap wall-clock processing time
// (a pathological file — e.g. a decompression bomb — must not hang a
// worker), and cap the final extracted text length (bounds downstream
// chunk/embedding fan-out regardless of how the text was produced).
const MAX_PDF_PAGES = 200;
const EXTRACTION_TIMEOUT_MS = 30_000;
export const MAX_EXTRACTED_TEXT_LENGTH = 2_000_000;

/** Truncates text to at most `maxLength` characters. Exported for testing. */
export function truncateExtractedText(
  text: string,
  maxLength: number = MAX_EXTRACTED_TEXT_LENGTH,
): string {
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Extracts plain text from an uploaded file buffer by content type / filename.
 * Text formats (txt, md, csv, html) are handled natively. Binary formats
 * (pdf, docx) require optional libraries; if unavailable we throw a clear error
 * rather than indexing garbage.
 */
export async function extractUploadText(
  filename: string,
  mimetype: string,
  buffer: Buffer,
): Promise<string> {
  const lower = filename.toLowerCase();
  const isHtml =
    mimetype.includes('html') ||
    lower.endsWith('.html') ||
    lower.endsWith('.htm');
  const isText =
    mimetype.startsWith('text/') ||
    lower.endsWith('.txt') ||
    lower.endsWith('.md') ||
    lower.endsWith('.markdown') ||
    lower.endsWith('.csv');
  const isPdf = mimetype.includes('pdf') || lower.endsWith('.pdf');
  const isDocx =
    mimetype.includes('officedocument.wordprocessing') ||
    lower.endsWith('.docx');

  if (isHtml) return truncateExtractedText(htmlToText(buffer.toString('utf8')));
  if (isText) return truncateExtractedText(buffer.toString('utf8').trim());
  if (isPdf) {
    const text = await withTimeout(
      extractPdf(buffer),
      EXTRACTION_TIMEOUT_MS,
      'PDF extraction',
    );
    return truncateExtractedText(text.trim());
  }
  if (isDocx) {
    const text = await withTimeout(
      extractDocx(buffer),
      EXTRACTION_TIMEOUT_MS,
      'DOCX extraction',
    );
    return truncateExtractedText(text.trim());
  }

  throw new Error(
    `Unsupported upload type '${mimetype || filename}'. Supported: txt, md, csv, html, pdf, docx.`,
  );
}

// Heavy parsers are imported lazily so they (and pdfjs) only load when a binary
// file is actually uploaded — keeping normal startup/tests light.
async function extractPdf(buffer: Buffer): Promise<string> {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText({ first: MAX_PDF_PAGES });
    return result.text;
  } finally {
    await parser.destroy();
  }
}

interface MammothLike {
  extractRawText(input: { buffer: Buffer }): Promise<{ value: string }>;
}

async function extractDocx(buffer: Buffer): Promise<string> {
  const mod = (await import('mammoth')) as unknown as {
    default?: MammothLike;
  } & MammothLike;
  const mammoth: MammothLike = mod.default ?? mod;
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}
