/**
 * Phase 4 (AC-H2): Content fetch with browser-automation routing detection.
 * Server-side fetch for simple HTML; flags JS-heavy sites as needs-browser.
 */
import type { FetchResult } from './types.js';

/** Known JS-heavy site patterns that need real browser rendering */
const JS_HEAVY_PATTERNS = [
  /^https?:\/\/(www\.)?(x|twitter)\.com\//,
  /^https?:\/\/(www\.)?xiaohongshu\.com\//,
  /^https?:\/\/(www\.)?bilibili\.com\//,
  /^https?:\/\/(www\.)?douyin\.com\//,
  /^https?:\/\/(www\.)?instagram\.com\//,
  /^https?:\/\/(www\.)?threads\.net\//,
];

const MAX_TEXT_LENGTH = 2000;

/** Private/internal IP patterns for SSRF protection */
const BLOCKED_HOSTS = [
  /^localhost(\.localdomain)?$/i,
  /\.localhost$/i,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^\[?::1\]?$/,
  /^\[?fe[89ab][0-9a-f]:/i,
  /^\[?f[cd][0-9a-f]{2}:/i,
  /^\[?::ffff:/i,
];

/** Validate URL for SSRF safety: only public HTTP(S) allowed */
export function validateUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`URL blocked: only HTTP(S) allowed, got ${parsed.protocol}`);
  }
  const host = parsed.hostname;
  if (BLOCKED_HOSTS.some((p) => p.test(host))) {
    throw new Error(`URL blocked: internal/private address not allowed (${host})`);
  }
}

export function needsBrowser(url: string): boolean {
  return JS_HEAVY_PATTERNS.some((p) => p.test(url));
}

/** Extract readable text from HTML — strips scripts, styles, and tags */
export function extractText(html: string): { title: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/is);
  const title = titleMatch ? titleMatch[1].trim() : '';
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { title, text: cleaned };
}

export function createFetchContentFn(): (url: string) => Promise<FetchResult> {
  return async (url: string): Promise<FetchResult> => {
    validateUrl(url);

    if (needsBrowser(url)) {
      return {
        text: '',
        title: '',
        url,
        method: 'browser',
        truncated: false,
      };
    }

    const res = await fetch(url, {
      headers: { 'User-Agent': 'CatCafe-WebDigest/1.0' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
    }
    const html = await res.text();
    const { title, text } = extractText(html);
    const truncated = text.length > MAX_TEXT_LENGTH;

    return {
      text: truncated ? text.slice(0, MAX_TEXT_LENGTH) : text,
      title,
      url,
      method: 'server-fetch',
      truncated,
    };
  };
}
