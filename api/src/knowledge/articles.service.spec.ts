import { buildArticleBody, buildArticleConfig } from './articles.service';

describe('buildArticleBody', () => {
  it('renders a Q&A pair as a heading + answer', () => {
    expect(
      buildArticleBody({
        question: 'Hoe retourneer ik?',
        answer: 'Binnen 14 dagen.',
        markdown: '',
      }),
    ).toBe('## Hoe retourneer ik?\n\nBinnen 14 dagen.');
  });

  it('appends free-form content below the Q&A', () => {
    expect(
      buildArticleBody({
        question: 'Q?',
        answer: 'A.',
        markdown: 'Extra detail.',
      }),
    ).toBe('## Q?\n\nA.\n\nExtra detail.');
  });

  it('renders content-only articles', () => {
    expect(buildArticleBody({ markdown: 'Just an article body.' })).toBe(
      'Just an article body.',
    );
  });
});

describe('buildArticleConfig', () => {
  it('converts html content to markdown', () => {
    const cfg = buildArticleConfig({
      title: 'Retour',
      content: '<p>Hello <strong>world</strong></p>',
      contentFormat: 'html',
    });
    expect(cfg.body).toContain('Hello **world**');
    expect(cfg.contentFormat).toBe('html');
    expect(cfg.sourceContent).toBe('<p>Hello <strong>world</strong></p>');
  });

  it('keeps markdown content verbatim when format is markdown', () => {
    const cfg = buildArticleConfig({
      title: 'T',
      content: '# Heading\n\ntext',
      contentFormat: 'markdown',
    });
    expect(cfg.body).toBe('# Heading\n\ntext');
  });

  it('defaults contentFormat to html', () => {
    const cfg = buildArticleConfig({
      title: 'T',
      content: '<p>x</p>',
    });
    expect(cfg.body).toBe('x');
  });

  it('embeds both question and answer into the body', () => {
    const cfg = buildArticleConfig({
      title: 'FAQ',
      question: 'Wat zijn de kosten?',
      answer: 'Gratis.',
    });
    expect(cfg.body).toBe('## Wat zijn de kosten?\n\nGratis.');
    expect(cfg.question).toBe('Wat zijn de kosten?');
    expect(cfg.answer).toBe('Gratis.');
  });

  it('deduplicates and trims categories/tags case-insensitively', () => {
    const cfg = buildArticleConfig({
      title: 'T',
      content: 'body',
      contentFormat: 'markdown',
      categories: [' Retour ', 'retour', 'Verzending'],
      tags: ['faq', 'FAQ', ''],
    });
    expect(cfg.categories).toEqual(['Retour', 'Verzending']);
    expect(cfg.tags).toEqual(['faq']);
  });

  it('leaves taxonomy empty when omitted', () => {
    const cfg = buildArticleConfig({ title: 'T', content: 'x' });
    expect(cfg.categories).toEqual([]);
    expect(cfg.tags).toEqual([]);
  });
});
