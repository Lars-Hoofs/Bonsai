import { shouldRunOcr } from './ocr-provider';

describe('shouldRunOcr', () => {
  it('runs OCR for a short/empty-text image when enabled', () => {
    expect(
      shouldRunOcr({
        ocrEnabled: true,
        extractedText: '',
        isImage: true,
        isPdf: false,
      }),
    ).toBe(true);
  });

  it('runs OCR for a short/empty-text PDF when enabled', () => {
    expect(
      shouldRunOcr({
        ocrEnabled: true,
        extractedText: '   \n  ',
        isImage: false,
        isPdf: true,
      }),
    ).toBe(true);
  });

  it('does not run OCR when disabled', () => {
    expect(
      shouldRunOcr({
        ocrEnabled: false,
        extractedText: '',
        isImage: true,
        isPdf: false,
      }),
    ).toBe(false);
  });

  it('does not run OCR when normal extraction already yielded real text', () => {
    expect(
      shouldRunOcr({
        ocrEnabled: true,
        extractedText: 'a'.repeat(200),
        isImage: true,
        isPdf: false,
      }),
    ).toBe(false);
  });

  it('does not run OCR for non-image/non-pdf types even with empty text', () => {
    expect(
      shouldRunOcr({
        ocrEnabled: true,
        extractedText: '',
        isImage: false,
        isPdf: false,
      }),
    ).toBe(false);
  });

  it('treats whitespace-only text as empty (boundary at OCR_MIN_TEXT_LENGTH)', () => {
    expect(
      shouldRunOcr({
        ocrEnabled: true,
        extractedText: 'x'.repeat(49),
        isImage: true,
        isPdf: false,
      }),
    ).toBe(true);
    expect(
      shouldRunOcr({
        ocrEnabled: true,
        extractedText: 'x'.repeat(50),
        isImage: true,
        isPdf: false,
      }),
    ).toBe(false);
  });
});
