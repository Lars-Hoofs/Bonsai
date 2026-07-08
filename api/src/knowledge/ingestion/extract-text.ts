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

  if (isHtml) return htmlToText(buffer.toString('utf8'));
  if (isText) return buffer.toString('utf8').trim();
  if (isPdf) return (await extractPdf(buffer)).trim();
  if (isDocx) return (await extractDocx(buffer)).trim();

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
    const result = await parser.getText();
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
