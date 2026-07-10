import {
  extractTitle,
  extractUploadText,
  htmlToText,
  isImageUpload,
  isPdfUpload,
  MAX_EXTRACTED_TEXT_LENGTH,
  truncateExtractedText,
} from './extract-text';
import type { OcrProvider } from './ocr-provider';

describe('htmlToText', () => {
  it('strips tags, scripts and styles and keeps readable text', () => {
    const html =
      '<html><head><style>.a{}</style><title>T</title></head>' +
      '<body><script>bad()</script><h1>Titel</h1><p>Hallo &amp; welkom</p></body></html>';
    const text = htmlToText(html);
    expect(text).toContain('Titel');
    expect(text).toContain('Hallo & welkom');
    expect(text).not.toContain('bad()');
    expect(text).not.toContain('<');
  });

  it('extractTitle reads the <title>, falling back when absent', () => {
    expect(extractTitle('<title>Hoi</title>', 'x')).toBe('Hoi');
    expect(extractTitle('<p>geen titel</p>', 'fallback')).toBe('fallback');
  });
});

describe('extractUploadText', () => {
  it('reads plain text and markdown', async () => {
    expect(
      await extractUploadText(
        'a.txt',
        'text/plain',
        Buffer.from('hallo wereld'),
      ),
    ).toBe('hallo wereld');
    expect(
      await extractUploadText('a.md', 'text/markdown', Buffer.from('# Titel')),
    ).toContain('# Titel');
  });

  it('converts uploaded html to text', async () => {
    const out = await extractUploadText(
      'p.html',
      'text/html',
      Buffer.from('<p>Hoi</p>'),
    );
    expect(out).toBe('Hoi');
  });

  it('throws a clear error on truly unsupported types', async () => {
    await expect(
      extractUploadText('a.xyz', 'application/x-thing', Buffer.from([0x00])),
    ).rejects.toThrow(/Unsupported upload type/);
  });

  it('truncates extracted text that exceeds the length cap', async () => {
    const huge = 'a'.repeat(MAX_EXTRACTED_TEXT_LENGTH + 1000);
    const out = await extractUploadText(
      'huge.txt',
      'text/plain',
      Buffer.from(huge),
    );
    expect(out.length).toBe(MAX_EXTRACTED_TEXT_LENGTH);
  });
});

describe('extractUploadText OCR fallback', () => {
  const fakeOcr = (
    text: string,
  ): { provider: OcrProvider; recognize: jest.Mock } => {
    const recognize = jest.fn().mockResolvedValue(text);
    return { provider: { recognize }, recognize };
  };

  it('falls back to OCR for an image whose normal extraction is empty', async () => {
    const { provider, recognize } = fakeOcr('Gescande tekst');
    const out = await extractUploadText(
      'scan.png',
      'image/png',
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      { ocrEnabled: true, ocrProvider: provider },
    );
    expect(out).toBe('Gescande tekst');
    expect(recognize).toHaveBeenCalledTimes(1);
  });

  it('does not run OCR when OCR_ENABLED is false', async () => {
    const { provider, recognize } = fakeOcr('Gescande tekst');
    const out = await extractUploadText(
      'scan.png',
      'image/png',
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      { ocrEnabled: false, ocrProvider: provider },
    );
    expect(out).toBe('');
    expect(recognize).not.toHaveBeenCalled();
  });

  it('does not run OCR when the image already yields real text (n/a for images, but never triggers on non-empty text)', async () => {
    // Images have no "normal extraction" text of their own (always empty),
    // so this documents the general short-circuit via a PDF with real text.
    const { provider, recognize } = fakeOcr('should not be used');
    const out = await extractUploadText(
      'doc.txt',
      'text/plain',
      Buffer.from('Plenty of real extracted text right here.'),
      { ocrEnabled: true, ocrProvider: provider },
    );
    expect(out).toBe('Plenty of real extracted text right here.');
    expect(recognize).not.toHaveBeenCalled();
  });

  it('keeps the (empty) extracted text and does not crash when OCR fails', async () => {
    const recognize = jest.fn().mockRejectedValue(new Error('engine crashed'));
    const provider: OcrProvider = { recognize };
    const out = await extractUploadText(
      'scan.png',
      'image/png',
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      { ocrEnabled: true, ocrProvider: provider },
    );
    expect(out).toBe('');
  });

  it('recognizes image mimetypes/extensions', () => {
    expect(isImageUpload('image/png', 'a.png')).toBe(true);
    expect(isImageUpload('image/jpeg', 'a.jpg')).toBe(true);
    expect(isImageUpload('application/octet-stream', 'a.jpeg')).toBe(true);
    expect(isImageUpload('text/plain', 'a.txt')).toBe(false);
  });

  it('recognizes pdf mimetypes/extensions', () => {
    expect(isPdfUpload('application/pdf', 'a.pdf')).toBe(true);
    expect(isPdfUpload('application/octet-stream', 'a.pdf')).toBe(true);
    expect(isPdfUpload('text/plain', 'a.txt')).toBe(false);
  });
});

describe('truncateExtractedText', () => {
  it('leaves short text untouched', () => {
    expect(truncateExtractedText('hello')).toBe('hello');
  });

  it('truncates text longer than the default cap', () => {
    const huge = 'x'.repeat(MAX_EXTRACTED_TEXT_LENGTH + 1);
    const result = truncateExtractedText(huge);
    expect(result.length).toBe(MAX_EXTRACTED_TEXT_LENGTH);
  });

  it('respects a custom max length', () => {
    expect(truncateExtractedText('abcdef', 3)).toBe('abc');
  });
});
