/**
 * Web Search & Fetch Tools — local MCP replacements for Anthropic server-side tools
 *
 * Root cause: The API proxy (Alibaba Cloud) does not implement Anthropic's
 * server-side WebSearch / WebFetch tools. These MCP tools provide equivalent
 * functionality using locally accessible search backends (cn.bing.com).
 *
 * Tools:
 * - cat_cafe_web_search: Search the web via Bing, return titles + URLs + snippets
 * - cat_cafe_web_fetch: Fetch a URL via curl, return plain text content
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { errorResult, successResult, type ToolResult } from './file-tools.js';

const execAsync = promisify(exec);

const SEARCH_TIMEOUT_MS = 15_000;
const FETCH_TIMEOUT_MS = 20_000;
const SEARCH_MAX_BYTES = 200_000; // 200KB for search results
const FETCH_MAX_BYTES = 1_000_000; // 1MB for fetched content

/**
 * Bing search URLs — global.bing.com serves correct international results
 * regardless of server location. cn.bing.com as fallback for Chinese queries.
 */
const BING_URLS = ['https://global.bing.com/search', 'https://cn.bing.com/search'];

/**
 * Detect if a query is primarily Chinese (for language parameter tuning).
 */
function isChineseQuery(query: string): boolean {
  const chineseChars = (query.match(/[一-鿿]/g) || []).length;
  return chineseChars > query.length * 0.3;
}

interface BingResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Extract the real URL from a Bing redirect link.
 * Bing wraps URLs in bing.com/ck/a?...&u=a1<base64url>&... format.
 */
function extractRealUrl(rawUrl: string): string {
  const url = rawUrl.replace(/&amp;/g, '&');
  const redirectMatch = url.match(/[?&]u=a1([A-Za-z0-9+/=-]+)/);
  if (!redirectMatch) return url;
  try {
    const b64 = redirectMatch[1].replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(b64, 'base64').toString('utf-8');
  } catch {
    return url;
  }
}

/**
 * Parse Bing search results HTML to extract titles, URLs, and snippets.
 * Bing uses <li class="b_algo"> for organic results.
 */
function parseBingResults(html: string): BingResult[] {
  const results: BingResult[] = [];

  // Match b_algo list items (organic search results)
  const resultBlocks = html.split(/class="b_algo"/).slice(1);

  for (const block of resultBlocks) {
    // Extract title from <h2>
    const h2Match = block.match(/<h2[^>]*>(.*?)<\/h2>/s);
    if (!h2Match) continue;

    const h2Content = h2Match[1];
    const linkMatch = h2Content.match(/<a[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/s);
    if (!linkMatch) continue;

    const title = linkMatch[2].replace(/<[^>]+>/g, '').trim();
    const url = extractRealUrl(linkMatch[1]);

    // Extract snippet from <p class="b_lineclamp...">
    let snippet = '';
    const snippetMatch = block.match(/<p[^>]*class="b_lineclamp[^"]*"[^>]*>(.*?)<\/p>/s);
    if (snippetMatch) {
      snippet = snippetMatch[1]
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&#\d+;/g, '')
        .trim();
    }

    if (title && url) {
      results.push({ title, url, snippet });
    }
    if (results.length >= 10) break;
  }

  return results;
}

/**
 * Execute a curl command with timeout and size limits.
 * Uses exec (shell) to avoid argument escaping issues with execFile.
 */
async function curlFetch(
  url: string,
  timeoutMs: number,
  maxSize: number,
  lang?: string,
  addBingCookies?: boolean,
): Promise<string> {
  const acceptLang = lang === 'zh' ? 'zh-CN,zh;q=0.9' : 'en-US,en;q=0.9';
  // Shell-escape the URL to prevent injection
  const safeUrl = url.replace(/'/g, "'\\''");
  // Bing cookies only added for search requests (not general web fetch)
  let cookieHeader = '';
  if (addBingCookies) {
    const edgeCookie =
      lang === 'zh'
        ? '_EDGE_S=mkt=zh-cn; SRCHD=AF=NOFORM; SRCHHPGUSR=SRCHLANG=zh'
        : '_EDGE_S=mkt=en-us; SRCHD=AF=NOFORM; SRCHHPGUSR=SRCHLANG=en';
    cookieHeader = ` -H 'Cookie: ${edgeCookie}'`;
  }
  // Note: no --max-filesize flag; curl returns error 63 when content exceeds limit
  // even for partial success. maxBuffer handles memory protection instead.
  const cmd = `curl -sL -m ${Math.floor(timeoutMs / 1000)} -A 'Mozilla/5.0' -H 'Accept-Language: ${acceptLang}'${cookieHeader} '${safeUrl}'`;
  try {
    const { stdout } = await execAsync(cmd, {
      maxBuffer: maxSize,
      timeout: timeoutMs + 2000,
    });
    return stdout;
  } catch (err) {
    const e = err as { message?: string; killed?: boolean; code?: number };
    if (e.killed) throw new Error(`Request timed out after ${timeoutMs}ms`);
    throw new Error(e.message || `curl failed with code ${e.code}`);
  }
}

/**
 * Strip HTML tags and extract plain text.
 */
function htmlToPlainText(html: string): string {
  let text = html;
  // Remove script and style blocks entirely
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '');
  text = text.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '');
  text = text.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '');
  // Replace block elements with newlines
  text = text.replace(/<(\/?(p|div|br|hr|h[1-6]|li|tr|table|section|article))[^>]*>/gi, '\n');
  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, ' ');
  // Decode common HTML entities
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, ' ');
  // Collapse whitespace
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n\s*\n\s*\n+/g, '\n\n');
  return text.trim();
}

/**
 * Tavily search — AI-native search engine optimized for LLMs.
 * Returns structured JSON with titles, URLs, and content snippets.
 * Docs: https://docs.tavily.com/docs/rest-api/api-reference
 */
async function tavilySearch(query: string, count: number): Promise<BingResult[]> {
  const apiKey = process.env.TAVILY_API_KEY?.trim();
  if (!apiKey) return [];

  const body = JSON.stringify({
    query,
    api_key: apiKey,
    max_results: count,
    include_answer: false,
    search_depth: 'basic',
  });

  try {
    const { stdout } = await execAsync(
      `curl -sL -m ${Math.floor(SEARCH_TIMEOUT_MS / 1000)} -X POST 'https://api.tavily.com/search' -H 'Content-Type: application/json' -d '${body.replace(/'/g, "'\\''")}'`,
      { maxBuffer: SEARCH_MAX_BYTES, timeout: SEARCH_TIMEOUT_MS + 2000 },
    );

    const data = JSON.parse(stdout) as { results?: Array<{ title: string; url: string; content: string }> };
    if (!data.results?.length) return [];

    return data.results.map((r) => ({
      title: r.title || '',
      url: r.url || '',
      snippet: (r.content || '').slice(0, 500),
    }));
  } catch {
    return [];
  }
}

/**
 * Exa search — neural/semantic search optimized for AI agents.
 * Returns structured results with text snippets.
 * Docs: https://docs.exa.ai/reference/search
 */
async function exaSearch(query: string, count: number): Promise<BingResult[]> {
  const apiKey = process.env.EXA_API_KEY?.trim();
  if (!apiKey) return [];

  const body = JSON.stringify({
    query,
    numResults: count,
    type: 'auto',
    contents: { highlights: true },
  });

  try {
    const { stdout } = await execAsync(
      `curl -sL -m ${Math.floor(SEARCH_TIMEOUT_MS / 1000)} -X POST 'https://api.exa.ai/search' -H 'x-api-key: ${apiKey}' -H 'Content-Type: application/json' -d '${body.replace(/'/g, "'\\''")}'`,
      { maxBuffer: SEARCH_MAX_BYTES, timeout: SEARCH_TIMEOUT_MS + 2000 },
    );

    const data = JSON.parse(stdout) as {
      results?: Array<{ title: string; url: string; highlights?: string[]; text?: string }>;
    };
    if (!data.results?.length) return [];

    return data.results.map((r) => ({
      title: r.title || '',
      url: r.url || '',
      // highlights is an array of query-relevant excerpts — join them
      snippet: (r.highlights?.join(' ') || r.text || '').slice(0, 500),
    }));
  } catch {
    return [];
  }
}

/**
 * Bing web scrape search — fallback when no API key is available.
 */
async function bingSearch(query: string, count: number): Promise<BingResult[]> {
  const chinese = isChineseQuery(query);
  const lang = chinese ? 'zh' : 'en';
  const mkt = chinese ? 'zh-CN' : 'en-US';
  const setlang = chinese ? 'zh-Hans' : 'en';

  for (const baseUrl of BING_URLS) {
    try {
      const searchUrl = `${baseUrl}?q=${encodeURIComponent(query)}&count=${count}&setlang=${setlang}&mkt=${mkt}`;
      const html = await curlFetch(searchUrl, SEARCH_TIMEOUT_MS, SEARCH_MAX_BYTES, lang, true);
      const results = parseBingResults(html);
      if (results.length > 0) return results;
    } catch {
      continue;
    }
  }
  return [];
}

export const webSearchInputSchema = {
  query: z.string().min(1).max(500).describe('Search query string'),
  count: z.number().int().min(1).max(10).optional().describe('Max results to return (default: 5)'),
};

export async function handleWebSearch(input: { query: string; count?: number }): Promise<ToolResult> {
  const query = input.query.trim();
  if (!query) return errorResult('query is required');
  const count = input.count ?? 5;

  try {
    // Provider chain: Tavily → Exa → Bing scrape (auto-fallback)
    let results: BingResult[] = [];
    let provider = '';

    // 1. Tavily (AI-native, 1000/mo free)
    if (results.length === 0 && process.env.TAVILY_API_KEY?.trim()) {
      results = await tavilySearch(query, count);
      if (results.length > 0) provider = 'tavily';
    }

    // 2. Exa (neural search, 1000/mo free)
    if (results.length === 0 && process.env.EXA_API_KEY?.trim()) {
      results = await exaSearch(query, count);
      if (results.length > 0) provider = 'exa';
    }

    // 3. Bing web scrape (free, no key needed, last resort)
    if (results.length === 0) {
      results = await bingSearch(query, count);
      if (results.length > 0) provider = 'bing';
    }

    if (results.length === 0) {
      return errorResult(`No search results found for: "${query}". The search backend may be unavailable.`);
    }

    const sourceTag = provider ? ` [via ${provider}]` : '';
    return successResult(
      `Search results for: "${query}"${sourceTag}\n\n${results
        .slice(0, count)
        .map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet}`)
        .join('\n\n')}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(`Web search failed: ${message}`);
  }
}

export const webFetchInputSchema = {
  url: z.string().url().describe('URL to fetch content from'),
  prompt: z
    .string()
    .optional()
    .describe('Optional: specific question to answer about the content (returns full text if omitted)'),
};

export async function handleWebFetch(input: { url: string; prompt?: string }): Promise<ToolResult> {
  const url = input.url.trim();
  if (!url) return errorResult('url is required');

  // Basic URL validation
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return errorResult('Only http:// and https:// URLs are supported');
    }
  } catch {
    return errorResult('Invalid URL format');
  }

  try {
    const html = await curlFetch(url, FETCH_TIMEOUT_MS, FETCH_MAX_BYTES);

    if (!html || html.trim().length === 0) {
      return errorResult(`Empty response from: ${url}`);
    }

    const plainText = htmlToPlainText(html);

    // Truncate if too long
    const maxLen = 50_000;
    const content =
      plainText.length > maxLen
        ? `${plainText.slice(0, maxLen)}\n\n…[truncated ${plainText.length - maxLen} chars]`
        : plainText;

    const parts = [`Source: ${url}`, `Content length: ${content.length} chars`];
    if (input.prompt) {
      parts.push(`Requested info: ${input.prompt}`);
    }
    parts.push('', '--- Content ---', content);

    return successResult(parts.join('\n'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(`Web fetch failed: ${message}`);
  }
}

export const webSearchTools = [
  {
    name: 'cat_cafe_web_search',
    description:
      'Search the web and return results with titles, URLs, and snippets. ' +
      'Use this when you need to find current information, look up documentation, or research a topic. ' +
      'This is a local MCP replacement for the Anthropic server-side WebSearch tool (which does not work through the API proxy).',
    inputSchema: webSearchInputSchema,
    handler: handleWebSearch,
  },
  {
    name: 'cat_cafe_web_fetch',
    description:
      'Fetch content from a URL and return it as plain text. ' +
      'Use this when you need to read a specific webpage, documentation page, or article. ' +
      'This is a local MCP replacement for the Anthropic server-side WebFetch tool (which does not work through the API proxy).',
    inputSchema: webFetchInputSchema,
    handler: handleWebFetch,
  },
] as const;
