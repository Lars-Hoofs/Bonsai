import {
  extractTitle,
  extractUploadText,
  htmlToText,
  MAX_EXTRACTED_TEXT_LENGTH,
  truncateExtractedText,
} from './extract-text';

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
