/**
 * Web Fetch Tools
 * MCP 工具: 为不支持 web search 的模型提供网页抓取能力
 *
 * 参考 relay-claw/web_fetch_tools.py 移植为 TypeScript 实现。
 */

import { z } from 'zod';
import type { ToolResult } from './file-tools.js';
import { errorResult, successResult } from './file-tools.js';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0.0.0 Safari/537.36';

const CHARSET_META_RE = /<meta[^>]+charset=["']?\s*([A-Za-z0-9._-]+)/i;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Decode DuckDuckGo redirect URLs (uddg parameter). */
function decodeDdgRedirect(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return raw;
  }
  if (parsed.pathname !== '/l/') return raw;
  const uddg = parsed.searchParams.get('uddg');
  return uddg ? decodeURIComponent(uddg) : raw;
}

/** Normalize URL: decode DDG redirects, default to https. */
function normalizeUrl(raw: string): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return '';
  const decoded = decodeDdgRedirect(trimmed);
  if (decoded.startsWith('http://') || decoded.startsWith('https://')) return decoded;
  return `https://${decoded}`;
}

/** Strip HTML tags and decode entities. */
function stripTags(html: string): string {
  // Remove tags, collapse whitespace
  const noTags = html.replace(/<[^>]+>/g, ' ');
  // Decode common HTML entities
  const decoded = noTags
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  return decoded.replace(/\s+/g, ' ').trim();
}

/** Truncate text to maxChars with indicator. */
function clipText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated]`;
}

/** Detect charset from Content-Type header or <meta> tag. */
function detectCharset(contentType: string, headChunk: string): string | undefined {
  // Check Content-Type header
  const headerMatch = /charset=([^\s;]+)/i.exec(contentType);
  if (headerMatch) return headerMatch[1].replace(/["']/g, '').trim();
  // Check <meta charset> in first chunk
  const metaMatch = CHARSET_META_RE.exec(headChunk);
  if (metaMatch) return metaMatch[1].trim();
  return undefined;
}

// ---------------------------------------------------------------------------
// Fetch logic
// ---------------------------------------------------------------------------

interface FetchResult {
  url: string;
  statusCode: number;
  title: string;
  content: string;
}

/** Fetch via Jina Reader as fallback for access-restricted pages. */
async function fetchViaJinaReader(
  url: string,
  timeoutMs: number,
): Promise<FetchResult> {
  const readerUrl = `https://r.jina.ai/${url}`;
  const response = await fetch(readerUrl, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Jina reader returned ${response.status}`);
  }
  const text = await response.text();
  return { url, statusCode: response.status, title: '', content: text.trim() };
}

/** Fetch a webpage, extract title and plain text content. */
async function fetchWebpage(
  url: string,
  timeoutMs: number,
): Promise<FetchResult> {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
  });

  // Fallback to Jina for access-restricted pages
  if (response.status === 401 || response.status === 403 || response.status === 429) {
    return fetchViaJinaReader(url, timeoutMs);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const rawText = await response.text();
  const contentType = response.headers.get('Content-Type') ?? '';

  // Detect charset — Node fetch already decodes to UTF-8 string via .text(),
  // but we keep detectCharset for logging/future use.
  detectCharset(contentType, rawText.slice(0, 4096));

  // Extract title
  const titleMatch = /<title[^>]*>(.*?)<\/title>/is.exec(rawText);
  const title = titleMatch ? stripTags(titleMatch[1]) : '';

  let content: string;
  if (contentType.toLowerCase().includes('html')) {
    // Remove script and style blocks, then strip tags
    content = rawText
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ');
    content = stripTags(content);
  } else {
    content = rawText.replace(/\s+/g, ' ').trim();
  }

  return {
    url: response.url,
    statusCode: response.status,
    title,
    content,
  };
}

// ---------------------------------------------------------------------------
// MCP Tool definition
// ---------------------------------------------------------------------------

export const webFetchInputSchema = {
  url: z.string().min(1).describe('The webpage URL to fetch'),
  max_chars: z
    .number()
    .int()
    .optional()
    .default(12000)
    .describe('Maximum characters in returned content (500-50000, default 12000)'),
  timeout_seconds: z
    .number()
    .int()
    .optional()
    .default(30)
    .describe('Request timeout in seconds (5-120, default 30)'),
};

export async function handleWebFetch(input: {
  url: string;
  max_chars?: number;
  timeout_seconds?: number;
}): Promise<ToolResult> {
  const url = normalizeUrl(input.url);
  if (!url) return errorResult('url cannot be empty.');

  const maxChars = Math.max(500, Math.min(input.max_chars ?? 12000, 50000));
  const timeoutMs = Math.max(5, Math.min(input.timeout_seconds ?? 30, 120)) * 1000;

  let data: FetchResult;
  try {
    data = await fetchWebpage(url, timeoutMs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(`Failed to fetch webpage: ${message}`);
  }

  const lines: string[] = [`URL: ${data.url}`, `Status: ${data.statusCode}`];
  if (data.title) lines.push(`Title: ${data.title}`);
  lines.push('Content:');
  lines.push(clipText(data.content || '[empty]', maxChars));

  return successResult(lines.join('\n'));
}

export const webFetchTools = [
  {
    name: 'cat_cafe_web_fetch',
    description:
      'Fetch webpage text content from a URL. Returns HTTP status, page title, and plain text content. ' +
      'Useful for models that do not have built-in web search — use this to retrieve information from web pages.',
    inputSchema: webFetchInputSchema,
    handler: handleWebFetch,
  },
] as const;
