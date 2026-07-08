import { extractTitle, extractUploadText, htmlToText } from './extract-text';

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
  it('reads plain text and markdown', () => {
    expect(
      extractUploadText('a.txt', 'text/plain', Buffer.from('hallo wereld')),
    ).toBe('hallo wereld');
    expect(
      extractUploadText('a.md', 'text/markdown', Buffer.from('# Titel')),
    ).toContain('# Titel');
  });

  it('converts uploaded html to text', () => {
    const out = extractUploadText(
      'p.html',
      'text/html',
      Buffer.from('<p>Hoi</p>'),
    );
    expect(out).toBe('Hoi');
  });

  it('throws a clear error on unsupported binary types', () => {
    expect(() =>
      extractUploadText('a.pdf', 'application/pdf', Buffer.from([0x25, 0x50])),
    ).toThrow(/Unsupported upload type/);
  });
});
