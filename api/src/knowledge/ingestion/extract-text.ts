import { OCR_MIN_TEXT_LENGTH, shouldRunOcr } from './ocr-provider';
import type { OcrProvider } from './ocr-provider';

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

/** Recognizes image uploads (jpg/png/etc): these have no "native" text
 * extraction path at all — the only way to get text out of them is OCR. */
export function isImageUpload(mimetype: string, filename: string): boolean {
  const lower = filename.toLowerCase();
  return (
    mimetype.startsWith('image/') ||
    /\.(png|jpe?g|gif|bmp|tiff?|webp)$/.test(lower)
  );
}

/** Recognizes PDF uploads, independent of whether the PDF text layer turns
 * out to be empty/near-empty (scanned PDF) at extraction time. */
export function isPdfUpload(mimetype: string, filename: string): boolean {
  return mimetype.includes('pdf') || filename.toLowerCase().endsWith('.pdf');
}

const OCR_TIMEOUT_MS = 30_000;

export interface ExtractUploadOptions {
  /** Whether OCR fallback is enabled at all (mirrors config OCR_ENABLED). */
  ocrEnabled?: boolean;
  /** Injectable OCR seam — tests stub this; production wires the real
   * self-hosted Tesseract-backed provider. Absent (e.g. no DI available)
   * means OCR is skipped even if ocrEnabled is true. */
  ocrProvider?: OcrProvider;
}

/**
 * Extracts plain text from an uploaded file buffer by content type / filename.
 * Text formats (txt, md, csv, html) are handled natively. Binary formats
 * (pdf, docx) require optional libraries; if unavailable we throw a clear error
 * rather than indexing garbage. Images have no native text extraction at all.
 *
 * After native extraction, if the result is empty/negligible AND the file is
 * an image or PDF (i.e. plausibly a scanned document) AND OCR is enabled and
 * a provider is supplied, OCR is run on the original buffer as a fallback.
 * OCR failures are swallowed — the (empty/short) native text is kept rather
 * than crashing ingestion; never surfaces raw OCR-engine errors to the caller.
 */
export async function extractUploadText(
  filename: string,
  mimetype: string,
  buffer: Buffer,
  options: ExtractUploadOptions = {},
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
  const isPdf = isPdfUpload(mimetype, filename);
  const isDocx =
    mimetype.includes('officedocument.wordprocessing') ||
    lower.endsWith('.docx');
  const isImage = isImageUpload(mimetype, filename);

  let text = '';
  if (isHtml) {
    text = truncateExtractedText(htmlToText(buffer.toString('utf8')));
  } else if (isText) {
    text = truncateExtractedText(buffer.toString('utf8').trim());
  } else if (isPdf) {
    const raw = await withTimeout(
      extractPdf(buffer),
      EXTRACTION_TIMEOUT_MS,
      'PDF extraction',
    );
    text = truncateExtractedText(raw.trim());
  } else if (isDocx) {
    const raw = await withTimeout(
      extractDocx(buffer),
      EXTRACTION_TIMEOUT_MS,
      'DOCX extraction',
    );
    text = truncateExtractedText(raw.trim());
  } else if (!isImage) {
    throw new Error(
      `Unsupported upload type '${mimetype || filename}'. Supported: txt, md, csv, html, pdf, docx, and images (via OCR).`,
    );
  }
  // Images fall through here with text === '' (no native extraction path),
  // which is exactly the "negligible text" state shouldRunOcr checks for.

  if (
    options.ocrProvider &&
    shouldRunOcr({
      ocrEnabled: options.ocrEnabled ?? false,
      extractedText: text,
      isImage,
      isPdf,
    })
  ) {
    try {
      const ocrText = await withTimeout(
        options.ocrProvider.recognize(buffer, mimetype, filename),
        OCR_TIMEOUT_MS,
        'OCR',
      );
      if (ocrText.trim().length > 0) {
        text = truncateExtractedText(ocrText.trim());
      }
    } catch {
      // OCR is a best-effort fallback: on failure, keep whatever (possibly
      // empty) text native extraction produced rather than crashing the
      // upload. The source/document still ingests, just with little/no text.
    }
  }

  return text;
}

// Re-exported for callers that want to reason about the "empty text"
// threshold without importing from ocr-provider directly.
export { OCR_MIN_TEXT_LENGTH };

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
