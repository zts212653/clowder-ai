import { defineMcpCanonicalFactory } from '../tool-governance-migration.js';

/**
 * Session Chain MCP Tools — F24 Phase D + F98
 * Tools for cats to read sealed session transcripts.
 *
 * Tools:
 * - list_session_chain: List sessions for a thread
 * - read_session_events: Paginated event read (view=raw|chat|handoff)
 * - read_session_digest: Read extractive digest
 * - read_invocation_detail: Read a bounded page of events for a specific invocation
 * - session_search: Full-text search across transcripts/digests
 */

import { z } from 'zod';
import type { ToolResult } from './file-tools.js';
import { errorResult, successResult } from './file-tools.js';
import {
  renderChatSessionEvents,
  renderHandoffSessionEvents,
  renderRawSessionEvents,
  SESSION_TOOL_RESPONSE_MAX_CHARS,
} from './session-chain-response.js';

const defineTool = defineMcpCanonicalFactory('session-chain-tools.ts', undefined, {
  resourceFamily: 'runtime-session',
  authority: 'local-runtime',
});

const API_URL = process.env['CAT_CAFE_API_URL'] ?? 'http://localhost:3004';

function resolveToolUserId(): string {
  return process.env['CAT_CAFE_USER_ID'] ?? 'default-user';
}

function resolveToolCatId(): string | undefined {
  return process.env['CAT_CAFE_CAT_ID'];
}

function buildAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'x-cat-cafe-user': resolveToolUserId(),
  };
  const catId = resolveToolCatId();
  if (catId) headers['x-cat-id'] = catId;
  return headers;
}

// --- list_session_chain ---

export const listSessionChainInputSchema = {
  threadId: z.string().min(1).describe('Thread ID'),
  catId: z
    .string()
    .optional()
    .describe(
      'Optional self filter; omit normally. If set, it must equal the current authenticated cat ID. Peer raw sessions are forbidden.',
    ),
  limit: z.number().int().min(1).max(100).optional().describe('Max results'),
  offset: z.number().int().min(0).optional().describe('Resume at this session-list offset'),
};

export async function handleListSessionChain(input: {
  threadId: string;
  catId?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}): Promise<ToolResult> {
  const params = new URLSearchParams();
  if (input.catId) params.set('catId', input.catId);
  params.set('limit', String(input.limit ?? 20));
  params.set('offset', String(input.offset ?? 0));

  const url = `${API_URL}/api/threads/${input.threadId}/sessions?${params.toString()}`;

  try {
    const res = await fetch(url, {
      headers: buildAuthHeaders(),
    });
    if (!res.ok) {
      return errorResult(`Failed to list sessions (${res.status}): ${await res.text()}`);
    }
    const data = (await res.json()) as {
      sessions: Array<{ id?: string; catId?: string; status?: string }>;
      hasMore?: boolean;
      nextOffset?: number;
    };
    const sessions = data.sessions;

    if (sessions.length === 0) {
      return successResult('No sessions found for this thread.');
    }

    const rendered = JSON.stringify(data, null, 2);
    if (rendered.length <= SESSION_TOOL_RESPONSE_MAX_CHARS) return successResult(rendered);
    const bounded = {
      sessions: sessions.map((session) => ({
        id: session.id,
        catId: session.catId,
        status: session.status,
        recordDetailUnavailable:
          'session list item exceeded the response budget; use the session ID to read its digest',
      })),
      hasMore: data.hasMore,
      nextOffset: data.nextOffset,
    };
    return successResult(JSON.stringify(bounded));
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
  charOffset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Exact character continuation within one raw event; requires cursor and limit=1'),
};

export async function handleReadSessionEvents(input: {
  sessionId: string;
  cursor?: number | undefined;
  limit?: number | undefined;
  view?: string | undefined;
  charOffset?: number | undefined;
}): Promise<ToolResult> {
  const params = new URLSearchParams();
  if (input.cursor != null) params.set('cursor', String(input.cursor));
  if (input.limit != null) params.set('limit', String(input.limit));
  if (input.view) params.set('view', input.view);
  if (input.charOffset != null) params.set('charOffset', String(input.charOffset));

  const url = `${API_URL}/api/sessions/${input.sessionId}/events?${params.toString()}`;

  try {
    const res = await fetch(url, {
      headers: buildAuthHeaders(),
    });
    if (!res.ok) {
      return errorResult(`Failed to read events (${res.status}): ${await res.text()}`);
    }

    const view = input.view ?? 'raw';

    if (input.charOffset != null) {
      const data = (await res.json()) as {
        eventNo: number;
        eventSlice: string;
        charOffset: number;
        totalChars: number;
        nextCharOffset?: number;
      };
      const lines = [
        `Event ${data.eventNo} JSON characters ${data.charOffset}-${data.charOffset + data.eventSlice.length} of ${data.totalChars}:`,
        data.eventSlice,
        ...(data.nextCharOffset === undefined
          ? []
          : [
              `Next slice: cat_cafe_read_session_events(sessionId=${JSON.stringify(input.sessionId)}, cursor=${data.eventNo}, limit=1, view="raw", charOffset=${data.nextCharOffset})`,
            ]),
      ];
      const text = lines.join('\n');
      return text.length <= SESSION_TOOL_RESPONSE_MAX_CHARS
        ? successResult(text)
        : errorResult('Session event slice exceeded its declared response budget');
    }

    if (view === 'chat') {
      const data = (await res.json()) as {
        messages: Array<{
          eventNo?: number;
          role: string;
          content?: string;
          timestamp: number;
          invocationId?: string;
          oversized?: boolean;
          contentLength?: number;
        }>;
        nextCursor?: { eventNo: number };
        total: number;
      };
      return successResult(renderChatSessionEvents({ sessionId: input.sessionId, ...data }));
    }

    if (view === 'handoff') {
      const data = (await res.json()) as {
        invocations: Array<{
          invocationId: string;
          startEventNo?: number;
          eventCount: number;
          toolCalls: string[];
          errors: number;
          durationMs: number;
          keyMessages: string[];
          oversized?: boolean;
        }>;
        nextCursor?: { eventNo: number };
        total: number;
      };
      return successResult(renderHandoffSessionEvents({ sessionId: input.sessionId, ...data }));
    }

    // raw view (default)
    const data = (await res.json()) as {
      events: Array<{ eventNo: number; event?: Record<string, unknown>; oversized?: boolean; eventChars?: number }>;
      nextCursor?: { eventNo: number };
      total: number;
    };
    return successResult(renderRawSessionEvents({ sessionId: input.sessionId, ...data }));
  } catch (err) {
    return errorResult(`Read events failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// --- read_session_digest ---

export const readSessionDigestInputSchema = {
  sessionId: z.string().min(1).describe('Session ID to read digest from'),
  charOffset: z.number().int().min(0).optional().describe('Exact character continuation within a large digest'),
};

export async function handleReadSessionDigest(input: { sessionId: string; charOffset?: number }): Promise<ToolResult> {
  const params = input.charOffset === undefined ? '' : `?charOffset=${input.charOffset}`;
  const url = `${API_URL}/api/sessions/${input.sessionId}/digest${params}`;

  try {
    const res = await fetch(url, {
      headers: buildAuthHeaders(),
    });
    if (!res.ok) {
      if (res.status === 404) {
        return successResult('No digest found for this session (may not be sealed yet).');
      }
      return errorResult(`Failed to read digest (${res.status}): ${await res.text()}`);
    }
    const data = (await res.json()) as Record<string, unknown>;
    if (typeof data.digestSlice === 'string') {
      const next = typeof data.nextCharOffset === 'number' ? data.nextCharOffset : undefined;
      return successResult(
        `Digest JSON characters ${data.charOffset}-${Number(data.charOffset) + data.digestSlice.length} of ${data.totalChars}:\n${data.digestSlice}${
          next === undefined
            ? ''
            : `\nNext slice: cat_cafe_read_session_digest(sessionId=${JSON.stringify(input.sessionId)}, charOffset=${next})`
        }`,
      );
    }
    if (data.oversized === true) {
      return successResult(
        `Digest is oversized (${data.digestChars} chars). Read exact JSON with cat_cafe_read_session_digest(sessionId=${JSON.stringify(input.sessionId)}, charOffset=0).`,
      );
    }
    const rendered = JSON.stringify(data);
    return rendered.length <= SESSION_TOOL_RESPONSE_MAX_CHARS
      ? successResult(rendered)
      : errorResult('Digest response exceeded the declared budget without source continuation');
  } catch (err) {
    return errorResult(`Read digest failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// --- read_invocation_detail (F98 Gap 2) ---

export const readInvocationDetailInputSchema = {
  sessionId: z.string().min(1).describe('Session ID containing the invocation'),
  invocationId: z.string().min(1).describe('Invocation ID to read events for'),
  cursor: z.number().int().min(0).optional().describe('Resume at this source event number'),
  limit: z.number().int().min(1).max(200).optional().describe('Maximum source events in this page (default 50)'),
};

export async function handleReadInvocationDetail(input: {
  sessionId: string;
  invocationId: string;
  cursor?: number;
  limit?: number;
}): Promise<ToolResult> {
  const params = new URLSearchParams({ limit: String(input.limit ?? 50) });
  if (input.cursor != null) params.set('cursor', String(input.cursor));
  const url = `${API_URL}/api/sessions/${input.sessionId}/invocations/${input.invocationId}?${params.toString()}`;

  try {
    const res = await fetch(url, {
      headers: buildAuthHeaders(),
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
      nextCursor?: { eventNo: number };
    };
    return successResult(
      `Invocation ${data.invocationId}: ${data.total} event(s)\n${renderRawSessionEvents({ sessionId: input.sessionId, ...data })}`,
    );
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
      headers: buildAuthHeaders(),
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
  defineTool({
    name: 'cat_cafe_list_session_chain',
    description:
      "List the authenticated cat's own session chain in one owner-visible thread. " +
      'Use when: recovering prior CLI/session work or locating a sealed session. ' +
      'Output: bounded session metadata with hasMore/nextOffset. ' +
      'NOT for peer raw sessions: they are forbidden; visible thread access does not grant them—use shared messages or owner-approved evidence. ' +
      'GOTCHA: omit catId normally; if supplied, it must be the authenticated cat. Read the digest before events.',
    inputSchema: listSessionChainInputSchema,
    handler: handleListSessionChain,
    governance: {
      implementationExport: 'handleListSessionChain',
      action: 'read',
      risk: { level: 'read', openWorld: false },
      runtimeProfiles: [
        'full',
        'readonly',
        'desktop:fable-phase0',
        'desktop:cloud-pro-phase0',
        'desktop:live-companion',
      ],
      targetExposure: 'lazy-discoverable',
    },
  }),
  defineTool({
    name: 'cat_cafe_read_session_events',
    description:
      'Read a bounded page from a sealed session transcript. Supports raw (default), chat, and handoff views; cursor is the exact source event number. ' +
      'VIEW SELECTION: ' +
      'handoff (RECOMMENDED first) = per-invocation summaries with tool calls and key messages — best overview of what happened. ' +
      'chat = role/content message pairs — useful when you need to see the actual conversation flow. ' +
      'raw = complete JSON events that fit; for one oversized event, use its cursor with limit=1 and charOffset to read the exact JSON in slices. ' +
      'GOTCHA: Only sealed (completed) sessions are readable — in-progress sessions return empty. ' +
      'TIP: Start with view=handoff to get the big picture, then use read_invocation_detail for specific invocations.',
    inputSchema: readSessionEventsInputSchema,
    handler: handleReadSessionEvents,
    governance: {
      implementationExport: 'handleReadSessionEvents',
      action: 'read',
      risk: { level: 'read', openWorld: false },
      runtimeProfiles: ['full', 'readonly', 'desktop:live-companion'],
      targetExposure: 'lazy-discoverable',
    },
  }),
  defineTool({
    name: 'cat_cafe_read_session_digest',
    description:
      'Read the extractive digest of a sealed session. Contains tool names, files touched, errors, and timing info. ' +
      'ALWAYS start here before reading full events — the digest gives you a quick overview ' +
      'so you know which parts of the session are worth drilling into. ' +
      'GOTCHA: An oversized digest returns a charOffset=0 drill; use charOffset to read exact JSON. In-progress sessions have no digest. ' +
      'TIP: After reading the digest, use read_session_events with view=handoff for more detail, ' +
      'or read_invocation_detail if the digest mentions a specific invocationId of interest.',
    inputSchema: readSessionDigestInputSchema,
    handler: handleReadSessionDigest,
    governance: {
      implementationExport: 'handleReadSessionDigest',
      action: 'read',
      risk: { level: 'read', openWorld: false },
      runtimeProfiles: [
        'full',
        'readonly',
        'desktop:fable-phase0',
        'desktop:cloud-pro-phase0',
        'desktop:live-companion',
      ],
      targetExposure: 'lazy-discoverable',
    },
  }),
  defineTool({
    name: 'cat_cafe_read_invocation_detail',
    description:
      'Read a bounded eventNo page for a specific invocation within a sealed session. ' +
      'Use AFTER search_evidence or read_session_events (handoff view) returns an invocationId you want to inspect. ' +
      'Follow nextCursor until complete; an oversized event points to read_session_events with exact eventNo and charOffset. ' +
      'GOTCHA: You need both sessionId AND invocationId. Get sessionId from list_session_chain, ' +
      'and invocationId from read_session_events (handoff view) or search_evidence results.',
    inputSchema: readInvocationDetailInputSchema,
    handler: handleReadInvocationDetail,
    governance: {
      implementationExport: 'handleReadInvocationDetail',
      action: 'read',
      risk: { level: 'read', openWorld: false },
      runtimeProfiles: ['full', 'readonly', 'desktop:live-companion'],
      targetExposure: 'lazy-discoverable',
    },
  }),
  // D15: cat_cafe_session_search removed — superseded by search_evidence unified entry point
] as const;
