import { htmlToMarkdown } from './html-to-markdown';

describe('htmlToMarkdown', () => {
  it('returns empty string for empty input', () => {
    expect(htmlToMarkdown('')).toBe('');
  });

  it('passes plain text through (treated as markdown), decoding entities', () => {
    expect(htmlToMarkdown('Hello &amp; welkom')).toBe('Hello & welkom');
  });

  it('leaves already-markdown untouched', () => {
    const md = '# Title\n\nSome **bold** text.';
    expect(htmlToMarkdown(md)).toBe(md);
  });

  it('converts headings', () => {
    expect(htmlToMarkdown('<h1>Big</h1>')).toBe('# Big');
    expect(htmlToMarkdown('<h3>Small</h3>')).toBe('### Small');
  });

  it('converts a paragraph', () => {
    expect(htmlToMarkdown('<p>Hello world</p>')).toBe('Hello world');
  });

  it('converts bold and italic', () => {
    expect(htmlToMarkdown('<p>A <strong>bold</strong> word</p>')).toBe(
      'A **bold** word',
    );
    expect(htmlToMarkdown('<p>An <em>italic</em> word</p>')).toBe(
      'An *italic* word',
    );
  });

  it('converts links', () => {
    expect(
      htmlToMarkdown('<p>See <a href="https://ex.eu/x">here</a></p>'),
    ).toBe('See [here](https://ex.eu/x)');
  });

  it('converts unordered lists', () => {
    const out = htmlToMarkdown('<ul><li>one</li><li>two</li></ul>');
    expect(out).toBe('- one\n- two');
  });

  it('converts ordered lists', () => {
    const out = htmlToMarkdown('<ol><li>first</li><li>second</li></ol>');
    expect(out).toBe('1. first\n2. second');
  });

  it('converts blockquotes', () => {
    expect(htmlToMarkdown('<blockquote>quoted text</blockquote>')).toBe(
      '> quoted text',
    );
  });

  it('preserves indentation inside code blocks', () => {
    const out = htmlToMarkdown('<pre>  line1\n    line2</pre>');
    expect(out).toBe('```\n  line1\n    line2\n```');
  });

  it('converts inline code', () => {
    expect(htmlToMarkdown('<p>run <code>npm i</code> now</p>')).toBe(
      'run `npm i` now',
    );
  });

  it('drops script and style content', () => {
    const out = htmlToMarkdown(
      '<p>Keep</p><script>alert(1)</script><style>.x{}</style>',
    );
    expect(out).toBe('Keep');
  });

  it('handles line breaks within a paragraph', () => {
    const out = htmlToMarkdown('<p>line1<br>line2</p>');
    expect(out).toContain('line1');
    expect(out).toContain('line2');
  });

  it('never leaks raw tags into the output', () => {
    const out = htmlToMarkdown(
      '<div><span>text</span></div><figure>x</figure>',
    );
    expect(out).not.toMatch(/<[^>]+>/);
    expect(out).toContain('text');
  });

  it('handles a multi-block rich-text document', () => {
    const html =
      '<h2>Retourbeleid</h2><p>Je kunt binnen <strong>14 dagen</strong> retourneren.</p><ul><li>Ongebruikt</li><li>Met bon</li></ul>';
    const out = htmlToMarkdown(html);
    expect(out).toBe(
      '## Retourbeleid\n\nJe kunt binnen **14 dagen** retourneren.\n\n- Ongebruikt\n- Met bon',
    );
  });
});
