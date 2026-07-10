/**
 * A small, self-contained HTML -> Markdown converter for the manual article /
 * Q&A editor. Rich-text editors (TipTap, Quill, ProseMirror, contenteditable)
 * emit HTML; we normalize it to Markdown once, at authoring time, so the stored
 * article body is a clean, diff-friendly Markdown string that the existing
 * chunking pipeline already handles well.
 *
 * This is intentionally dependency-free (self-hosted constraint) and covers the
 * subset of HTML those editors produce: headings, paragraphs, bold/italic,
 * links, ordered/unordered lists, blockquotes, inline/`pre` code, horizontal
 * rules and line breaks. Anything it does not recognise degrades to its text
 * content, so no markup is ever leaked into the indexed body. It is NOT a
 * general-purpose or security-sensitive sanitizer — it produces text for
 * embedding, not HTML for rendering.
 *
 * If the input contains no HTML tags at all it is treated as already-Markdown
 * (or plain text) and returned essentially unchanged, so callers may pass
 * either representation.
 */

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)));
}

/** True if the string appears to contain HTML markup at all. */
function looksLikeHtml(input: string): boolean {
  return /<\/?[a-z][\s\S]*?>/i.test(input);
}

function collapseBlankLines(s: string): string {
  return s
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

type Rule = { re: RegExp; replace: (...groups: string[]) => string };

// Applied in order; earlier rules unwrap block/inline structure into Markdown,
// later rules strip anything left over. `[\s\S]` is used instead of `.` so the
// (non-greedy) matches span newlines inside block elements.
const RULES: Rule[] = [
  { re: /<(script|style)[\s\S]*?<\/\1>/gi, replace: () => '' },
  { re: /<!--[\s\S]*?-->/g, replace: () => '' },
  // Headings.
  {
    re: /<h1[^>]*>([\s\S]*?)<\/h1>/gi,
    replace: (_m, c) => `\n\n# ${inline(c)}\n\n`,
  },
  {
    re: /<h2[^>]*>([\s\S]*?)<\/h2>/gi,
    replace: (_m, c) => `\n\n## ${inline(c)}\n\n`,
  },
  {
    re: /<h3[^>]*>([\s\S]*?)<\/h3>/gi,
    replace: (_m, c) => `\n\n### ${inline(c)}\n\n`,
  },
  {
    re: /<h4[^>]*>([\s\S]*?)<\/h4>/gi,
    replace: (_m, c) => `\n\n#### ${inline(c)}\n\n`,
  },
  {
    re: /<h5[^>]*>([\s\S]*?)<\/h5>/gi,
    replace: (_m, c) => `\n\n##### ${inline(c)}\n\n`,
  },
  {
    re: /<h6[^>]*>([\s\S]*?)<\/h6>/gi,
    replace: (_m, c) => `\n\n###### ${inline(c)}\n\n`,
  },
  // Preformatted / code blocks (before generic <code>).
  {
    re: /<pre[^>]*>([\s\S]*?)<\/pre>/gi,
    replace: (_m, c) => {
      const text = decodeEntities(c.replace(/<[^>]+>/g, '')).replace(
        /\n+$/,
        '',
      );
      return `\n\n\`\`\`\n${text}\n\`\`\`\n\n`;
    },
  },
  {
    re: /<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi,
    replace: (_m, c) => blockquote(c),
  },
  { re: /<ul[^>]*>([\s\S]*?)<\/ul>/gi, replace: (_m, c) => list(c, false) },
  { re: /<ol[^>]*>([\s\S]*?)<\/ol>/gi, replace: (_m, c) => list(c, true) },
  { re: /<(hr)\s*\/?>/gi, replace: () => '\n\n---\n\n' },
  {
    re: /<p[^>]*>([\s\S]*?)<\/p>/gi,
    replace: (_m, c) => `\n\n${inline(c)}\n\n`,
  },
];

/** Converts a run of inline-level HTML to Markdown inline syntax. */
function inline(html: string): string {
  const md = html
    .replace(/<br\s*\/?>/gi, '  \n')
    .replace(
      /<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi,
      (_m: string, _t: string, c: string) => `**${inline(c)}**`,
    )
    .replace(
      /<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi,
      (_m: string, _t: string, c: string) => `*${inline(c)}*`,
    )
    .replace(
      /<code[^>]*>([\s\S]*?)<\/code>/gi,
      (_m: string, c: string) =>
        `\`${decodeEntities(c.replace(/<[^>]+>/g, ''))}\``,
    )
    .replace(
      /<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
      (_m: string, href: string, c: string) => `[${inline(c)}](${href})`,
    )
    .replace(/<[^>]+>/g, '');
  return decodeEntities(md)
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function list(html: string, ordered: boolean): string {
  const items = [...html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((m) =>
    inline(m[1]),
  );
  const lines = items.map((it, i) => `${ordered ? `${i + 1}.` : '-'} ${it}`);
  return `\n\n${lines.join('\n')}\n\n`;
}

function blockquote(html: string): string {
  const text = inline(html);
  const lines = text
    .split('\n')
    .map((l) => `> ${l}`.trimEnd())
    .join('\n');
  return `\n\n${lines}\n\n`;
}

/**
 * Converts rich-text HTML to Markdown. Idempotent on already-Markdown / plain
 * text input (returned trimmed with entities decoded). Never throws.
 */
export function htmlToMarkdown(input: string): string {
  if (!input) return '';
  if (!looksLikeHtml(input)) {
    return collapseBlankLines(decodeEntities(input));
  }
  let out = input;
  for (const { re, replace } of RULES) {
    out = out.replace(re, (...args) => {
      // String.prototype.replace passes (match, ...groups, offset, string).
      const groups = args.slice(0, -2) as string[];
      return replace(...groups);
    });
  }
  // Convert any inline markup left outside a block element (bold/italic/link/
  // code, stray <br>) line by line, so the block structure built above (its
  // newlines) is preserved. Lines inside a fenced code block are passed through
  // verbatim (indentation matters and must not be collapsed).
  let inFence = false;
  out = out
    .split('\n')
    .map((line) => {
      if (line.trimStart().startsWith('```')) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return line.trim() === '' ? '' : inline(line);
    })
    .join('\n');
  return collapseBlankLines(out);
}
