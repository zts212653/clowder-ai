import { z } from 'zod';
import type { ToolResult } from './file-tools.js';
import { errorResult, successResult } from './file-tools.js';

const API_URL = process.env['CAT_CAFE_API_URL'] ?? 'http://localhost:3004';
const SIGNAL_USER = process.env['CAT_CAFE_SIGNAL_USER']?.trim() || 'codex';

interface SignalArticleLike {
  readonly id: string;
  readonly title: string;
  readonly source: string;
  readonly tier: number;
  readonly fetchedAt: string;
  readonly url: string;
  readonly status: string;
  readonly summary?: string | undefined;
  readonly content?: string | undefined;
}

async function apiJson(
  path: string,
  init?: RequestInit,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  try {
    const headers = new Headers(init?.headers);
    headers.set('X-Cat-Cafe-User', SIGNAL_USER);
    if (init?.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    const response = await fetch(`${API_URL}${path}`, {
      ...init,
      headers,
    });

    if (!response.ok) {
      const text = await response.text();
      return {
        ok: false,
        error: `Signals API failed (${response.status}): ${text}`,
      };
    }

    return {
      ok: true,
      data: await response.json(),
    };
  } catch (error) {
    return {
      ok: false,
      error: `Signals API request failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function summarizeContent(content: string, maxLength: number): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  const truncated = normalized.slice(0, maxLength).trim();
  const sentenceCut = truncated.replace(/[.!?]\s+[^.!?]*$/, '').trim();
  if (sentenceCut.length >= Math.floor(maxLength * 0.6)) {
    return sentenceCut;
  }

  return `${truncated}...`;
}

function formatArticleLine(article: SignalArticleLike): string {
  return `- [${article.id}] ${article.title} (${article.source}/T${article.tier}) ${article.fetchedAt}`;
}

export const signalListInboxInputSchema = {
  limit: z.number().int().min(1).max(100).optional().describe('Max inbox items to return (default: 20)'),
  tier: z
    .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
    .optional()
    .describe('Filter by signal tier'),
  source: z.string().min(1).max(200).optional().describe('Filter by source id'),
};

export const signalGetArticleInputSchema = {
  id: z.string().min(1).optional().describe('Signal article id'),
  url: z.string().url().optional().describe('Signal article url (alternative to id)'),
};

export const signalSearchInputSchema = {
  query: z.string().min(1).max(500).describe('Search query string'),
  limit: z.number().int().min(1).max(100).optional().describe('Max search results (default: 20)'),
  status: z.enum(['inbox', 'read', 'starred', 'archived']).optional().describe('Filter by signal article status'),
  source: z.string().min(1).max(200).optional().describe('Filter by source id'),
  tier: z
    .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
    .optional()
    .describe('Filter by signal tier'),
  dateFrom: z.string().optional().describe('ISO date/time lower bound for fetchedAt'),
  dateTo: z.string().optional().describe('ISO date/time upper bound for fetchedAt'),
};

export const signalMarkReadInputSchema = {
  id: z.string().min(1).describe('Signal article id'),
};

export const signalSummarizeInputSchema = {
  id: z.string().min(1).describe('Signal article id'),
  maxLength: z.number().int().min(100).max(1200).optional().describe('Maximum summary length (default: 280)'),
};

export async function handleSignalListInbox(input: {
  limit?: number | undefined;
  tier?: 1 | 2 | 3 | 4 | undefined;
  source?: string | undefined;
}): Promise<ToolResult> {
  const params = new URLSearchParams();
  if (input.limit !== undefined) params.set('limit', String(input.limit));
  if (input.tier !== undefined) params.set('tier', String(input.tier));
  if (input.source) params.set('source', input.source);

  const suffix = params.toString();
  const result = await apiJson(`/api/signals/inbox${suffix ? `?${suffix}` : ''}`);
  if (!result.ok) {
    return errorResult(result.error);
  }

  const data = result.data as { items?: SignalArticleLike[] };
  const items = Array.isArray(data.items) ? data.items : [];
  if (items.length === 0) {
    return successResult('No inbox articles found.');
  }

  const lines = ['Signal inbox:', ...items.map((item) => formatArticleLine(item))];
  return successResult(lines.join('\n'));
}

export async function handleSignalGetArticle(input: {
  id?: string | undefined;
  url?: string | undefined;
}): Promise<ToolResult> {
  if (!input.id && !input.url) {
    return errorResult('Either id or url is required');
  }

  const result = input.id
    ? await apiJson(`/api/signals/articles/${encodeURIComponent(input.id)}`)
    : await apiJson(`/api/signals/articles/by-url?url=${encodeURIComponent(input.url ?? '')}`);

  if (!result.ok) {
    return errorResult(result.error);
  }

  const data = result.data as { article?: SignalArticleLike };
  if (!data.article) {
    return errorResult('Signals API returned no article payload');
  }

  return successResult(JSON.stringify(data.article, null, 2));
}

export async function handleSignalSearch(input: {
  query: string;
  limit?: number | undefined;
  status?: 'inbox' | 'read' | 'starred' | 'archived' | undefined;
  source?: string | undefined;
  tier?: 1 | 2 | 3 | 4 | undefined;
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
}): Promise<ToolResult> {
  const params = new URLSearchParams({ q: input.query });
  if (input.limit !== undefined) params.set('limit', String(input.limit));
  if (input.status) params.set('status', input.status);
  if (input.source) params.set('source', input.source);
  if (input.tier !== undefined) params.set('tier', String(input.tier));
  if (input.dateFrom) params.set('dateFrom', input.dateFrom);
  if (input.dateTo) params.set('dateTo', input.dateTo);

  const result = await apiJson(`/api/signals/search?${params.toString()}`);
  if (!result.ok) {
    return errorResult(result.error);
  }

  const data = result.data as { total?: number; items?: SignalArticleLike[] };
  const items = Array.isArray(data.items) ? data.items : [];
  if (items.length === 0) {
    return successResult(`No signal article matched query: ${input.query}`);
  }

  const lines = [
    `Found ${data.total ?? items.length} signal article(s):`,
    ...items.map((item) => formatArticleLine(item)),
  ];
  return successResult(lines.join('\n'));
}

export async function handleSignalMarkRead(input: { id: string }): Promise<ToolResult> {
  const result = await apiJson(`/api/signals/articles/${encodeURIComponent(input.id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'read' }),
  });

  if (!result.ok) {
    return errorResult(result.error);
  }

  return successResult(`Marked signal article as read: ${input.id}`);
}

export async function handleSignalSummarize(input: {
  id: string;
  maxLength?: number | undefined;
}): Promise<ToolResult> {
  const articleResult = await apiJson(`/api/signals/articles/${encodeURIComponent(input.id)}`);
  if (!articleResult.ok) {
    return errorResult(articleResult.error);
  }

  const articleData = articleResult.data as { article?: SignalArticleLike };
  if (!articleData.article) {
    return errorResult('Signals API returned no article payload');
  }

  const sourceText = articleData.article.content ?? articleData.article.summary ?? articleData.article.title;
  const summary = summarizeContent(sourceText, input.maxLength ?? 280);

  const updateResult = await apiJson(`/api/signals/articles/${encodeURIComponent(input.id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ summary }),
  });
  if (!updateResult.ok) {
    return errorResult(updateResult.error);
  }

  return successResult(`Summary updated for ${input.id}\n${summary}`);
}

export const signalsTools = [
  {
    name: 'signal_list_inbox',
    description:
      'List recent signal articles from inbox. Use when 铲屎官 asks to check signals, or when you need to browse unread articles. ' +
      'Supports optional limit, tier, and source filters. ' +
      'TIER GUIDE: T1 = critical/breaking, T2 = important, T3 = interesting, T4 = low priority. ' +
      'Returns article IDs needed for other signal tools (get_article, mark_read, start_study).',
    inputSchema: signalListInboxInputSchema,
    handler: handleSignalListInbox,
  },
  {
    name: 'signal_get_article',
    description:
      'Get full signal article detail by id or URL. Returns title, content, source, tier, timestamps, and metadata. ' +
      'Use when you need to read the full content of a specific article. ' +
      'PARAM GUIDE: Use id (from list_inbox/search results) OR url (if 铲屎官 shared a link) — not both.',
    inputSchema: signalGetArticleInputSchema,
    handler: handleSignalGetArticle,
  },
  {
    name: 'signal_search',
    description:
      'Search signal articles by keyword with optional filters (status, source, tier, date range). ' +
      'Use when looking for articles about a specific topic across all statuses. ' +
      'TIP: Combine with dateFrom/dateTo for time-bounded searches (ISO date format).',
    inputSchema: signalSearchInputSchema,
    handler: handleSignalSearch,
  },
  {
    name: 'signal_mark_read',
    description:
      'Mark a signal article as read. Use after you or 铲屎官 have reviewed an article. ' +
      'This removes it from the inbox view.',
    inputSchema: signalMarkReadInputSchema,
    handler: handleSignalMarkRead,
  },
  {
    name: 'signal_summarize',
    description:
      'Generate a concise summary for a signal article and persist it to article frontmatter. ' +
      'Use when an article needs a quick summary for later reference. ' +
      'Default maxLength is 280 chars (tweet-length). Increase for more detailed summaries (max 1200).',
    inputSchema: signalSummarizeInputSchema,
    handler: handleSignalSummarize,
  },
] as const;
