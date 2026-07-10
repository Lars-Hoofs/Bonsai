import { Injectable, Logger } from '@nestjs/common';
import type { OcrProvider } from './ocr-provider';

/**
 * Self-hosted OCR via tesseract.js (pure JS/WASM, downloads/caches its own
 * language traineddata — no external Docker service, no paid API). Language
 * data is fetched on first use per configured language and cached by
 * tesseract.js itself; `languages` is config-driven (OCR_LANGUAGES) so an
 * operator can add/remove languages without a code change.
 *
 * PDF handling note: this recognizes the raw buffer directly. tesseract.js
 * can OCR an image buffer out of the box; it does NOT rasterize PDF pages
 * itself. Full scanned-PDF support therefore requires rendering each PDF
 * page to an image first (e.g. via pdfjs-dist + node-canvas) before handing
 * it to Tesseract — tracked as a follow-up (see class doc below). Image
 * uploads (the common case for e.g. a photographed receipt/document) are
 * fully supported today.
 */
@Injectable()
export class TesseractOcrProvider implements OcrProvider {
  private readonly logger = new Logger(TesseractOcrProvider.name);

  constructor(private readonly languages: string) {}

  async recognize(
    buffer: Buffer,
    mimetype: string,
    filename: string,
  ): Promise<string> {
    if (mimetype.includes('pdf') || filename.toLowerCase().endsWith('.pdf')) {
      // Follow-up (see class doc): PDF page rasterization isn't implemented
      // yet, so a scanned PDF has no image bytes to feed Tesseract. Return
      // empty rather than attempting to OCR raw PDF bytes as an image (which
      // would either throw or produce garbage).
      this.logger.warn(
        `Skipping OCR for '${filename}': PDF rasterization not yet implemented (image uploads are supported)`,
      );
      return '';
    }

    // Lazy import: tesseract.js pulls in a WASM core + worker machinery that
    // should only load when OCR is actually invoked, keeping normal
    // startup/tests (which stub this provider) light.
    const { recognize } = await import('tesseract.js');
    const result = await recognize(buffer, this.languages);
    return result.data.text;
  }
}
