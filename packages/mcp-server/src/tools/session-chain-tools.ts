/**
 * Session Chain MCP Tools — F24 Phase D + F98
 * Tools for cats to read sealed session transcripts.
 *
 * Tools:
 * - list_session_chain: List sessions for a thread
 * - read_session_events: Paginated event read (view=raw|chat|handoff)
 * - read_session_digest: Read extractive digest
 * - read_invocation_detail: Read all events for a specific invocation
 * - session_search: Full-text search across transcripts/digests
 */

import { z } from 'zod';
import type { ToolResult } from './file-tools.js';
import { errorResult, successResult } from './file-tools.js';

const API_URL = process.env['CAT_CAFE_API_URL'] ?? 'http://localhost:3004';

/** Resolve userId: env var (invocation-bound, tamper-proof) > default */
function resolveToolUserId(): string {
  return process.env['CAT_CAFE_USER_ID'] ?? 'default-user';
}

// --- list_session_chain ---

export const listSessionChainInputSchema = {
  threadId: z.string().min(1).describe('Thread ID'),
  catId: z.string().optional().describe('Filter by cat ID (opus/codex/gemini)'),
  limit: z.number().int().min(1).max(100).optional().describe('Max results'),
};

export async function handleListSessionChain(input: {
  threadId: string;
  catId?: string | undefined;
  limit?: number | undefined;
}): Promise<ToolResult> {
  const params = new URLSearchParams();
  if (input.catId) params.set('catId', input.catId);

  const url = `${API_URL}/api/threads/${input.threadId}/sessions?${params.toString()}`;

  try {
    const res = await fetch(url, {
      headers: { 'x-cat-cafe-user': resolveToolUserId() },
    });
    if (!res.ok) {
      return errorResult(`Failed to list sessions (${res.status}): ${await res.text()}`);
    }
    const data = (await res.json()) as { sessions: unknown[] };
    const sessions = input.limit ? data.sessions.slice(0, input.limit) : data.sessions;

    if (sessions.length === 0) {
      return successResult('No sessions found for this thread.');
    }

    return successResult(JSON.stringify(sessions, null, 2));
  } catch (err) {
    return errorResult(`List sessions failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// --- read_session_events ---

export const readSessionEventsInputSchema = {
  sessionId: z.string().min(1).describe('Session ID to read events from'),
  cursor: z.number().int().min(0).optional().describe('Start from event number (0-based)'),
  limit: z.number().int().min(1).max(200).optional().describe('Max events per page (default 50)'),
  view: z
    .enum(['raw', 'chat', 'handoff'])
    .optional()
    .describe(
      'View mode: raw (default, full JSONL events), chat (role/content pairs), handoff (per-invocation summaries)',
    ),
};

export async function handleReadSessionEvents(input: {
  sessionId: string;
  cursor?: number | undefined;
  limit?: number | undefined;
  view?: string | undefined;
}): Promise<ToolResult> {
  const params = new URLSearchParams();
  if (input.cursor != null) params.set('cursor', String(input.cursor));
  if (input.limit != null) params.set('limit', String(input.limit));
  if (input.view) params.set('view', input.view);

  const url = `${API_URL}/api/sessions/${input.sessionId}/events?${params.toString()}`;

  try {
    const res = await fetch(url, {
      headers: { 'x-cat-cafe-user': resolveToolUserId() },
    });
    if (!res.ok) {
      return errorResult(`Failed to read events (${res.status}): ${await res.text()}`);
    }

    const view = input.view ?? 'raw';

    if (view === 'chat') {
      const data = (await res.json()) as {
        messages: Array<{ role: string; content: string; timestamp: number; invocationId?: string }>;
        nextCursor?: { eventNo: number };
        total: number;
      };
      const lines: string[] = [];
      lines.push(`Total events: ${data.total}, messages: ${data.messages.length}`);
      if (data.nextCursor) lines.push(`Next cursor: ${data.nextCursor.eventNo}`);
      lines.push('');
      for (const msg of data.messages) {
        lines.push(`[${msg.role}] ${msg.content.slice(0, 300)}`);
      }
      return successResult(lines.join('\n'));
    }

    if (view === 'handoff') {
      const data = (await res.json()) as {
        invocations: Array<{
          invocationId: string;
          eventCount: number;
          toolCalls: string[];
          errors: number;
          durationMs: number;
          keyMessages: string[];
        }>;
        nextCursor?: { eventNo: number };
        total: number;
      };
      const lines: string[] = [];
      lines.push(`Total events: ${data.total}, invocations: ${data.invocations.length}`);
      if (data.nextCursor) lines.push(`Next cursor: ${data.nextCursor.eventNo}`);
      lines.push('');
      for (const inv of data.invocations) {
        const dur = inv.durationMs > 0 ? ` (${Math.round(inv.durationMs / 1000)}s)` : '';
        lines.push(`--- Invocation ${inv.invocationId}${dur} ---`);
        lines.push(`  Events: ${inv.eventCount}, Errors: ${inv.errors}`);
        if (inv.toolCalls.length > 0) lines.push(`  Tools: ${inv.toolCalls.join(', ')}`);
        for (const msg of inv.keyMessages) {
          lines.push(`  > ${msg}`);
        }
        lines.push('');
      }
      return successResult(lines.join('\n'));
    }

    // raw view (default)
    const data = (await res.json()) as {
      events: Array<{ eventNo: number; event: { type?: string } }>;
      nextCursor?: { eventNo: number };
      total: number;
    };
    const lines: string[] = [];
    lines.push(`Total events: ${data.total}, returned: ${data.events.length}`);
    if (data.nextCursor) lines.push(`Next cursor: ${data.nextCursor.eventNo}`);
    lines.push('');
    for (const evt of data.events) {
      const evtType = evt.event?.type ?? 'unknown';
      lines.push(`[${evt.eventNo}] ${evtType}: ${JSON.stringify(evt.event).slice(0, 300)}`);
    }
    return successResult(lines.join('\n'));
  } catch (err) {
    return errorResult(`Read events failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// --- read_session_digest ---

export const readSessionDigestInputSchema = {
  sessionId: z.string().min(1).describe('Session ID to read digest from'),
};

export async function handleReadSessionDigest(input: { sessionId: string }): Promise<ToolResult> {
  const url = `${API_URL}/api/sessions/${input.sessionId}/digest`;

  try {
    const res = await fetch(url, {
      headers: { 'x-cat-cafe-user': resolveToolUserId() },
    });
    if (!res.ok) {
      if (res.status === 404) {
        return successResult('No digest found for this session (may not be sealed yet).');
      }
      return errorResult(`Failed to read digest (${res.status}): ${await res.text()}`);
    }
    const data = await res.json();
    return successResult(JSON.stringify(data, null, 2));
  } catch (err) {
    return errorResult(`Read digest failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// --- read_invocation_detail (F98 Gap 2) ---

export const readInvocationDetailInputSchema = {
  sessionId: z.string().min(1).describe('Session ID containing the invocation'),
  invocationId: z.string().min(1).describe('Invocation ID to read events for'),
};

export async function handleReadInvocationDetail(input: {
  sessionId: string;
  invocationId: string;
}): Promise<ToolResult> {
  const url = `${API_URL}/api/sessions/${input.sessionId}/invocations/${input.invocationId}`;

  try {
    const res = await fetch(url, {
      headers: { 'x-cat-cafe-user': resolveToolUserId() },
    });
    if (!res.ok) {
      if (res.status === 404) {
        return successResult('Invocation not found in this session.');
      }
      return errorResult(`Failed to read invocation (${res.status}): ${await res.text()}`);
    }
    const data = (await res.json()) as {
      invocationId: string;
      events: Array<{ eventNo: number; event: Record<string, unknown> }>;
      total: number;
    };

    const lines: string[] = [];
    lines.push(`Invocation ${data.invocationId}: ${data.total} event(s)`);
    lines.push('');
    for (const evt of data.events) {
      const evtType = (evt.event['type'] as string) ?? 'unknown';
      lines.push(`[${evt.eventNo}] ${evtType}: ${JSON.stringify(evt.event).slice(0, 300)}`);
    }
    return successResult(lines.join('\n'));
  } catch (err) {
    return errorResult(`Read invocation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// --- session_search ---

export const sessionSearchInputSchema = {
  threadId: z.string().min(1).describe('Thread ID to search within'),
  query: z.string().min(1).max(500).describe('Search query'),
  cats: z.string().optional().describe('Comma-separated cat IDs to filter'),
  limit: z.number().int().min(1).max(50).optional().describe('Max results (default 10)'),
  scope: z.enum(['digests', 'transcripts', 'both']).optional().describe('Search scope (default both)'),
};

export async function handleSessionSearch(input: {
  threadId: string;
  query: string;
  cats?: string | undefined;
  limit?: number | undefined;
  scope?: string | undefined;
}): Promise<ToolResult> {
  const params = new URLSearchParams({ q: input.query });
  if (input.cats) params.set('cats', input.cats);
  if (input.limit != null) params.set('limit', String(input.limit));
  if (input.scope) params.set('scope', input.scope);

  const url = `${API_URL}/api/threads/${input.threadId}/sessions/search?${params.toString()}`;

  try {
    const res = await fetch(url, {
      headers: { 'x-cat-cafe-user': resolveToolUserId() },
    });
    if (!res.ok) {
      return errorResult(`Search failed (${res.status}): ${await res.text()}`);
    }
    const data = (await res.json()) as {
      hits: Array<{
        score: number;
        sessionId: string;
        kind: string;
        snippet: string;
        pointer: { eventNo?: number; invocationId?: string };
      }>;
    };

    if (data.hits.length === 0) {
      return successResult(`No results found for: ${input.query}`);
    }

    const lines: string[] = [];
    lines.push(`Found ${data.hits.length} result(s) for "${input.query}":`);
    lines.push('');

    for (const hit of data.hits) {
      lines.push(`[${hit.kind}] session=${hit.sessionId} score=${hit.score}`);
      if (hit.pointer.eventNo != null) {
        lines.push(`  eventNo: ${hit.pointer.eventNo}`);
      }
      if (hit.pointer.invocationId) {
        lines.push(`  invocationId: ${hit.pointer.invocationId} (use read_invocation_detail to inspect)`);
      }
      lines.push(`  > ${hit.snippet.slice(0, 200).replace(/\n/g, ' ')}`);
      lines.push('');
    }

    return successResult(lines.join('\n'));
  } catch (err) {
    return errorResult(`Search failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// --- Tool definitions ---

export const sessionChainTools = [
  {
    name: 'cat_cafe_list_session_chain',
    description:
      'List session chain for a thread. Shows session IDs, sequence numbers, status, and context health for each cat.',
    inputSchema: listSessionChainInputSchema,
    handler: handleListSessionChain,
  },
  {
    name: 'cat_cafe_read_session_events',
    description:
      'Read events from a sealed session transcript. Supports view modes: raw (default, full events), chat (role/content pairs), handoff (per-invocation summaries). Pagination via cursor.',
    inputSchema: readSessionEventsInputSchema,
    handler: handleReadSessionEvents,
  },
  {
    name: 'cat_cafe_read_session_digest',
    description:
      'Read the extractive digest of a sealed session. Contains tool names, files touched, errors, and timing info. Use this first before reading full events.',
    inputSchema: readSessionDigestInputSchema,
    handler: handleReadSessionDigest,
  },
  {
    name: 'cat_cafe_read_invocation_detail',
    description:
      'Read all events for a specific invocation within a sealed session. Use after search_evidence or read_session_events returns an invocationId to inspect what happened.',
    inputSchema: readInvocationDetailInputSchema,
    handler: handleReadInvocationDetail,
  },
  // D15: cat_cafe_session_search removed — superseded by search_evidence unified entry point
] as const;
