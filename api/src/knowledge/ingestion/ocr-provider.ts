/**
 * Port for OCR'ing a scanned upload (PDF/image with little or no extractable
 * text) into plain text. The concrete provider runs self-hosted Tesseract
 * (via tesseract.js, in-process WASM — no external service, no paid API);
 * tests stub this seam with a canned result so real OCR never runs in
 * unit/integration tests.
 */
export interface OcrProvider {
  /**
   * Recognizes text in `buffer` (an image, or a PDF handled as image-like
   * input). `mimetype`/`filename` are passed through for provider-side
   * format handling. Must never throw for "no text found" — return an empty
   * string instead; throwing is reserved for genuine OCR-engine failures,
   * which callers treat as "OCR unavailable" rather than crashing ingestion.
   */
  recognize(
    buffer: Buffer,
    mimetype: string,
    filename: string,
  ): Promise<string>;
}

export const OCR_PROVIDER = Symbol('OCR_PROVIDER');

/** Below this length, extracted text is considered "empty/negligible" —
 * i.e. the upload is probably a scanned document rather than real text. */
export const OCR_MIN_TEXT_LENGTH = 50;

/**
 * Decides whether OCR should be attempted as a fallback: only when OCR is
 * enabled, the normal extraction yielded little/no text, and the file is a
 * type OCR can plausibly help with (image or PDF — a scanned docx/txt/html
 * doesn't happen in practice, and OCR'ing arbitrary bytes for other types
 * would be pointless work at best).
 */
export function shouldRunOcr(params: {
  ocrEnabled: boolean;
  extractedText: string;
  isImage: boolean;
  isPdf: boolean;
}): boolean {
  if (!params.ocrEnabled) return false;
  if (!params.isImage && !params.isPdf) return false;
  return params.extractedText.trim().length < OCR_MIN_TEXT_LENGTH;
}
