import { Logger } from '@nestjs/common';
import { safeFetch } from '../../common/safe-fetch';

const logger = new Logger('site-crawler');

export interface CrawlOptions {
  maxPages: number;
  maxDepth: number;
}

export interface CrawledPage {
  url: string;
  html: string;
}

/** Fetches `url` via the SSRF-guarded `safeFetch` and returns the response
 * body as text. This is the default `fetchPage` used when the caller does
 * not inject one (tests inject a stub instead, since `safeFetch` blocks
 * loopback addresses used by test fixture servers). */
async function defaultFetchPage(url: string): Promise<string> {
  const res = await safeFetch(url, { maxBytes: 5_000_000 });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Unexpected status ${res.status} fetching ${url}`);
  }
  return res.body;
}

/** File extensions that are obviously not HTML — skipped during link
 * discovery so the crawler doesn't waste fetches on assets. */
const NON_HTML_EXTENSIONS = [
  '.pdf',
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.svg',
  '.webp',
  '.ico',
  '.css',
  '.js',
  '.mjs',
  '.json',
  '.xml',
  '.zip',
  '.mp4',
  '.mp3',
  '.avi',
  '.mov',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
];

function hasNonHtmlExtension(pathname: string): boolean {
  const lower = pathname.toLowerCase();
  return NON_HTML_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Resolves an `href` found on `pageUrl` to an absolute, same-origin,
 * http(s), HTML-looking URL — or `null` if it should be skipped (a
 * different scheme like mailto:/tel:, a bare fragment, cross-origin, or an
 * obviously non-HTML asset).
 */
function resolveCrawlableLink(href: string, pageUrl: URL): string | null {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  if (/^(mailto|tel|javascript):/i.test(trimmed)) return null;

  let resolved: URL;
  try {
    resolved = new URL(trimmed, pageUrl);
  } catch {
    return null;
  }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
    return null;
  }
  if (resolved.origin !== pageUrl.origin) return null;
  if (hasNonHtmlExtension(resolved.pathname)) return null;

  resolved.hash = '';
  return resolved.toString();
}

/** Extracts every `<a href="...">` target from `html`, resolved against
 * `pageUrl` and filtered to same-origin, http(s), HTML-looking links. */
function extractLinks(html: string, pageUrl: URL): string[] {
  const links: string[] = [];
  const re = /<a\b[^>]*\bhref\s*=\s*["']([^"']*)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const resolved = resolveCrawlableLink(m[1], pageUrl);
    if (resolved) links.push(resolved);
  }
  return links;
}

/** Extracts same-origin `<loc>` URLs from a sitemap.xml body. Returns `null`
 * if the body doesn't look like a valid sitemap at all (so the caller can
 * fall back to link-crawling), or the (possibly empty) list of URLs found. */
function parseSitemapLocs(xml: string, origin: string): string[] | null {
  if (!/<urlset[\s>]/i.test(xml) && !/<sitemapindex[\s>]/i.test(xml)) {
    return null;
  }
  const locs: string[] = [];
  const re = /<loc>([\s\S]*?)<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const raw = m[1].trim();
    try {
      const url = new URL(raw);
      if (url.origin === origin) locs.push(url.toString());
    } catch {
      // Ignore unparseable <loc> entries.
    }
  }
  return locs;
}

/**
 * Crawls a website starting from `startUrl`, discovering pages either via
 * its sitemap.xml (preferred, if present and valid) or by breadth-first
 * same-origin link-following (fallback). Bounded by `opts.maxPages` and
 * `opts.maxDepth` (the latter only applies to the link-crawl fallback, since
 * a sitemap has no notion of depth).
 *
 * `fetchPage` is injected so callers can route through `safeFetch` (the
 * default, SSRF-guarded) or a test stub. A page whose fetch throws is
 * skipped (logged), not fatal to the overall crawl.
 *
 * Known limitation: does not honor robots.txt.
 */
export async function crawlSite(
  startUrl: string,
  opts: CrawlOptions,
  fetchPage: (url: string) => Promise<string> = defaultFetchPage,
): Promise<CrawledPage[]> {
  const start = new URL(startUrl);
  const maxPages = Math.max(1, opts.maxPages);
  const maxDepth = Math.max(0, opts.maxDepth);

  const sitemapUrls = await tryLoadSitemap(start, fetchPage, maxPages);
  if (sitemapUrls !== null) {
    const pages: CrawledPage[] = [];
    for (const url of sitemapUrls) {
      if (pages.length >= maxPages) break;
      const html = await tryFetch(url, fetchPage);
      if (html !== null) pages.push({ url, html });
    }
    return pages;
  }

  return bfsDiscover(start, fetchPage, maxPages, maxDepth);
}

async function tryFetch(
  url: string,
  fetchPage: (url: string) => Promise<string>,
): Promise<string | null> {
  try {
    return await fetchPage(url);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn(`Skipping page ${url}: ${detail}`);
    return null;
  }
}

/** Attempts to load and parse `${origin}/sitemap.xml`. Returns the (capped,
 * deduped) list of same-origin URLs it contains, or `null` if the sitemap
 * could not be fetched or did not parse as a sitemap. */
async function tryLoadSitemap(
  start: URL,
  fetchPage: (url: string) => Promise<string>,
  maxPages: number,
): Promise<string[] | null> {
  const sitemapUrl = `${start.origin}/sitemap.xml`;
  let xml: string;
  try {
    xml = await fetchPage(sitemapUrl);
  } catch {
    return null;
  }
  const locs = parseSitemapLocs(xml, start.origin);
  if (locs === null) return null;
  const deduped = Array.from(new Set(locs));
  return deduped.slice(0, maxPages);
}

/** Breadth-first, same-origin link-crawl starting from `start`, bounded by
 * `maxPages` (total pages returned) and `maxDepth` (hops from the start
 * page). Each page is fetched exactly once (its HTML is kept, both to
 * discover further links and as the returned page content). */
async function bfsDiscover(
  start: URL,
  fetchPage: (url: string) => Promise<string>,
  maxPages: number,
  maxDepth: number,
): Promise<CrawledPage[]> {
  const startUrl = start.toString();
  const visited = new Set<string>([startUrl]);
  const pages: CrawledPage[] = [];
  let frontier: string[] = [startUrl];
  let depth = 0;

  while (frontier.length > 0 && pages.length < maxPages) {
    const next: string[] = [];
    for (const url of frontier) {
      if (pages.length >= maxPages) break;
      const html = await tryFetch(url, fetchPage);
      if (html === null) continue;
      pages.push({ url, html });

      if (depth >= maxDepth) continue;
      const links = extractLinks(html, new URL(url));
      for (const link of links) {
        if (visited.has(link)) continue;
        visited.add(link);
        next.push(link);
      }
    }
    frontier = next;
    depth++;
  }
  return pages;
}
