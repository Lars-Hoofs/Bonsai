import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

/**
 * SSRF-safe fetch helpers.
 *
 * Server-side requests to a tenant-supplied URL (website crawler sources,
 * outbound webhooks) must never be allowed to reach internal/private network
 * ranges — including the cloud metadata address 169.254.169.254 — or a
 * tenant could use Bonsai as a network scanning/SSRF proxy into our
 * infrastructure.
 *
 * Known limitation (accepted for now): validation resolves DNS and checks
 * the resolved addresses *before* the request is made, but the actual
 * `fetch()` call performs its own, separate DNS resolution when connecting.
 * Between the two lookups a DNS record could change ("DNS rebinding") to
 * point at a blocked address. Fully closing that window requires a custom
 * `lookup`/connect hook that pins the exact validated IP for the socket
 * (e.g. via `undici`'s `Agent` with a custom `connect`), which is out of
 * scope here since we cannot add new dependencies. This is a documented,
 * accepted residual risk.
 */

const IPV4_OCTET = 0xff;

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > IPV4_OCTET) return null;
    result = (result << 8) | n;
  }
  return result >>> 0;
}

function ipv4InCidr(ip: string, base: string, prefix: number): boolean {
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(base);
  if (ipInt === null || baseInt === null) return false;
  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

function isBlockedIpv4(ip: string): boolean {
  return (
    ipv4InCidr(ip, '127.0.0.0', 8) || // loopback
    ipv4InCidr(ip, '10.0.0.0', 8) || // private
    ipv4InCidr(ip, '172.16.0.0', 12) || // private
    ipv4InCidr(ip, '192.168.0.0', 16) || // private
    ipv4InCidr(ip, '169.254.0.0', 16) || // link-local incl. cloud metadata
    ip === '0.0.0.0' || // unspecified
    ipv4InCidr(ip, '224.0.0.0', 4) // multicast
  );
}

/**
 * Extracts the IPv4 address from an IPv4-mapped IPv6 literal
 * (`::ffff:a.b.c.d`), if present. Returns null otherwise.
 */
function extractIpv4MappedAddress(ip: string): string | null {
  const match = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(ip);
  return match ? match[1] : null;
}

function isBlockedIpv6(ip: string): boolean {
  const mapped = extractIpv4MappedAddress(ip);
  if (mapped) return isBlockedIpv4(mapped);

  const normalized = ip.toLowerCase();
  if (normalized === '::1') return true; // loopback
  if (normalized === '::') return true; // unspecified

  // fc00::/7 (unique local addresses): first 7 bits are 1111 110x, i.e. the
  // first hextet is in [0xfc00, 0xfdff].
  const firstHextet = parseInt(normalized.split(':')[0] || '0', 16);
  if (firstHextet >= 0xfc00 && firstHextet <= 0xfdff) return true;

  // fe80::/10 (link-local): first hextet in [0xfe80, 0xfebf].
  if (firstHextet >= 0xfe80 && firstHextet <= 0xfebf) return true;

  // ff00::/8 (multicast): first hextet in [0xff00, 0xffff].
  if (firstHextet >= 0xff00 && firstHextet <= 0xffff) return true;

  return false;
}

/**
 * True if `ip` is a loopback, private, link-local, unspecified, or multicast
 * address (IPv4 or IPv6) that must never be reached from a server-side
 * fetch on tenant-supplied input.
 */
export function isBlockedIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isBlockedIpv4(ip);
  if (version === 6) return isBlockedIpv6(ip);
  return true; // not a valid IP literal — treat as unsafe/unknown
}

/**
 * Validates that `rawUrl` is an http(s) URL whose hostname resolves only to
 * public (non-blocked) addresses. Throws `Error('Blocked URL')` otherwise.
 * Returns the parsed URL on success.
 */
export async function assertPublicHttpUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Blocked URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Blocked URL');
  }
  if (!url.hostname) {
    throw new Error('Blocked URL');
  }

  // Strip surrounding brackets from a literal IPv6 hostname, e.g. "[::1]".
  const hostname =
    url.hostname.startsWith('[') && url.hostname.endsWith(']')
      ? url.hostname.slice(1, -1)
      : url.hostname;

  if (isIP(hostname)) {
    if (isBlockedIp(hostname)) throw new Error('Blocked URL');
    return url;
  }

  let addresses: { address: string }[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new Error('Blocked URL');
  }
  if (addresses.length === 0) {
    throw new Error('Blocked URL');
  }
  for (const { address } of addresses) {
    if (isBlockedIp(address)) throw new Error('Blocked URL');
  }

  return url;
}

export interface SafeFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

export interface SafeFetchResult {
  status: number;
  body: string;
  finalUrl: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 5_000_000;
const DEFAULT_MAX_REDIRECTS = 3;

/**
 * SSRF-safe fetch: validates the URL (and every redirect hop) against
 * `assertPublicHttpUrl`, enforces a request timeout and a response-size cap,
 * and never automatically follows a redirect to an unvalidated location.
 */
export async function safeFetch(
  rawUrl: string,
  opts: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  let currentUrl = rawUrl;
  for (let redirects = 0; ; redirects++) {
    const url = await assertPublicHttpUrl(currentUrl);

    const res = await fetch(url, {
      method: opts.method,
      headers: opts.headers,
      body: opts.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) {
        throw new Error(`Redirect ${res.status} without Location header`);
      }
      if (redirects >= maxRedirects) {
        throw new Error('Too many redirects');
      }
      currentUrl = new URL(location, url).toString();
      continue;
    }

    const body = await readBodyWithLimit(res, maxBytes);
    return { status: res.status, body, finalUrl: url.toString() };
  }
}

async function readBodyWithLimit(
  res: Response,
  maxBytes: number,
): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`Response body exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8').decode(combined);
}
