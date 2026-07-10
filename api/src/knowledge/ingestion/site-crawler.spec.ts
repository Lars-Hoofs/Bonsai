import { crawlSite } from './site-crawler';

/** Builds a fake page-fetcher over a fixed url->html map: resolves with the
 * html for known urls, rejects for anything else (mirroring a 404). No real
 * I/O ever happens, so this deliberately has no `await` inside. */
function fakeFetcher(
  pages: Record<string, string>,
): (url: string) => Promise<string> {
  return (url: string) => {
    const html = pages[url];
    if (html === undefined) return Promise.reject(new Error(`404: ${url}`));
    return Promise.resolve(html);
  };
}

describe('crawlSite', () => {
  const page = (title: string, links: string[] = []): string =>
    `<html><head><title>${title}</title></head><body>` +
    links.map((l) => `<a href="${l}">link</a>`).join('') +
    `<p>Body of ${title}</p></body></html>`;

  it('prefers a valid sitemap over link-following', async () => {
    const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://example.com/a</loc></url>
        <url><loc>https://example.com/b</loc></url>
        <url><loc>https://example.com/c</loc></url>
      </urlset>`;
    const pages: Record<string, string> = {
      'https://example.com/sitemap.xml': sitemap,
      'https://example.com/a': page('A'),
      'https://example.com/b': page('B'),
      'https://example.com/c': page('C'),
    };
    const fetchPage = jest.fn(fakeFetcher(pages));

    const result = await crawlSite(
      'https://example.com/',
      { maxPages: 50, maxDepth: 2 },
      fetchPage,
    );

    expect(result.map((r) => r.url).sort()).toEqual([
      'https://example.com/a',
      'https://example.com/b',
      'https://example.com/c',
    ]);
    // Sitemap path never follows links from the start page itself.
    expect(fetchPage).toHaveBeenCalledWith('https://example.com/sitemap.xml');
  });

  it('caps sitemap URLs at maxPages and restricts to same-origin', async () => {
    const sitemap = `<urlset>
        <url><loc>https://example.com/a</loc></url>
        <url><loc>https://example.com/b</loc></url>
        <url><loc>https://other.com/evil</loc></url>
      </urlset>`;
    const pages: Record<string, string> = {
      'https://example.com/sitemap.xml': sitemap,
      'https://example.com/a': page('A'),
      'https://example.com/b': page('B'),
    };
    const fetchPage = jest.fn(fakeFetcher(pages));

    const result = await crawlSite(
      'https://example.com/',
      { maxPages: 1, maxDepth: 2 },
      fetchPage,
    );

    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('https://example.com/a');
  });

  it('falls back to BFS link-crawling when no sitemap exists', async () => {
    const pages: Record<string, string> = {
      'https://example.com/': page('Home', [
        '/page1',
        'https://example.com/page2',
        'https://external.com/other',
        'mailto:foo@example.com',
        '#fragment',
        '/file.pdf',
      ]),
      'https://example.com/page1': page('Page1'),
      'https://example.com/page2': page('Page2'),
    };
    const fetchPage = jest.fn(fakeFetcher(pages));

    const result = await crawlSite(
      'https://example.com/',
      { maxPages: 50, maxDepth: 2 },
      fetchPage,
    );

    const urls = result.map((r) => r.url).sort();
    expect(urls).toEqual([
      'https://example.com/',
      'https://example.com/page1',
      'https://example.com/page2',
    ]);
    expect(fetchPage).not.toHaveBeenCalledWith('https://external.com/other');
  });

  it('respects maxDepth in link-crawl mode', async () => {
    const pages: Record<string, string> = {
      'https://example.com/': page('Home', ['/level1']),
      'https://example.com/level1': page('Level1', ['/level2']),
      'https://example.com/level2': page('Level2', ['/level3']),
      'https://example.com/level3': page('Level3'),
    };
    const fetchPage = jest.fn(fakeFetcher(pages));

    const result = await crawlSite(
      'https://example.com/',
      { maxPages: 50, maxDepth: 1 },
      fetchPage,
    );

    const urls = result.map((r) => r.url).sort();
    // depth 0 = start page, depth 1 = level1; level2/level3 not reached.
    expect(urls).toEqual([
      'https://example.com/',
      'https://example.com/level1',
    ]);
  });

  it('respects maxPages in link-crawl mode', async () => {
    const pages: Record<string, string> = {
      'https://example.com/': page('Home', ['/a', '/b', '/c']),
      'https://example.com/a': page('A'),
      'https://example.com/b': page('B'),
      'https://example.com/c': page('C'),
    };
    const fetchPage = jest.fn(fakeFetcher(pages));

    const result = await crawlSite(
      'https://example.com/',
      { maxPages: 2, maxDepth: 2 },
      fetchPage,
    );

    expect(result).toHaveLength(2);
  });

  it('skips a page fetch that throws rather than failing the whole crawl', async () => {
    const pages: Record<string, string> = {
      'https://example.com/': page('Home', ['/broken', '/ok']),
      'https://example.com/ok': page('Ok'),
    };
    const fetchPage = jest.fn(fakeFetcher(pages));

    const result = await crawlSite(
      'https://example.com/',
      { maxPages: 50, maxDepth: 2 },
      fetchPage,
    );

    const urls = result.map((r) => r.url).sort();
    expect(urls).toEqual(['https://example.com/', 'https://example.com/ok']);
  });

  it('dedupes links to the same page reached via multiple paths', async () => {
    const pages: Record<string, string> = {
      'https://example.com/': page('Home', ['/a', '/b']),
      'https://example.com/a': page('A', ['/shared']),
      'https://example.com/b': page('B', ['/shared']),
      'https://example.com/shared': page('Shared'),
    };
    const fetchPage = jest.fn(fakeFetcher(pages));

    const result = await crawlSite(
      'https://example.com/',
      { maxPages: 50, maxDepth: 2 },
      fetchPage,
    );

    const sharedCount = result.filter(
      (r) => r.url === 'https://example.com/shared',
    ).length;
    expect(sharedCount).toBe(1);
  });

  it('ignores an invalid/malformed sitemap and falls back to link-crawling', async () => {
    const pages: Record<string, string> = {
      'https://example.com/sitemap.xml': '<not valid xml at all',
      'https://example.com/': page('Home', ['/page1']),
      'https://example.com/page1': page('Page1'),
    };
    const fetchPage = jest.fn(fakeFetcher(pages));

    const result = await crawlSite(
      'https://example.com/',
      { maxPages: 50, maxDepth: 2 },
      fetchPage,
    );

    const urls = result.map((r) => r.url).sort();
    expect(urls).toEqual(['https://example.com/', 'https://example.com/page1']);
  });
});
