/**
 * F252 Phase E — Thread-level Replay Event Fetcher
 *
 * Fetches all sealed sessions for a thread and merges their events
 * into a single time-sorted stream for thread-level replay.
 *
 * AC-E2: "同一 thread 下所有 session 按时间串联"
 *
 * Note: CLI transcripts only contain assistant-side events (text, tool_use,
 * tool_result, system_info). User prompts are stored in the chat message
 * store, not in the CLI event stream. This fetcher supplements transcript
 * events with user messages from the chat history API so the replay
 * shows the complete conversation (user prompts + assistant responses).
 */

import type { ChatMessage } from '@/stores/chat-types';
import { getMessageTimelineOrderTime } from '@/stores/message-timeline';
import { apiFetch } from '@/utils/api-client';
import { mergeSessionEvents } from './merge-session-events';
import { mergeHubMessagesWithTranscriptSupplements } from './thread-message-events';
import type { RawTranscriptEvent } from './types';

// Re-export for convenience
export { mergeSessionEvents } from './merge-session-events';

// ---------------------------------------------------------------------------
// API interaction (integration layer)
// ---------------------------------------------------------------------------

/**
 * Fetch all session IDs for a thread.
 * Includes active/sealing sessions so the current conversation is replayable
 * — events already recorded are valid for replay even if the session is ongoing.
 */
async function fetchThreadSessionIds(threadId: string): Promise<string[]> {
  const res = await apiFetch(`/api/threads/${threadId}/sessions`);
  if (!res.ok) {
    throw new Error(`Failed to fetch thread sessions: ${res.status}`);
  }
  const data = (await res.json()) as {
    sessions?: Array<{ id: string; status: 'active' | 'sealing' | 'sealed' }>;
  };
  return (data.sessions ?? []).map((s) => s.id);
}

/**
 * Fetch all events for a single session (handles pagination).
 */
async function fetchSessionEvents(sessionId: string): Promise<RawTranscriptEvent[]> {
  const all: RawTranscriptEvent[] = [];
  let cursorEventNo: number | undefined;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const params = new URLSearchParams({ view: 'raw', limit: '200' });
    if (cursorEventNo != null) params.set('cursor', String(cursorEventNo));

    const res = await apiFetch(`/api/sessions/${sessionId}/events?${params.toString()}`);
    if (!res.ok) {
      throw new Error(`Failed to fetch session ${sessionId} events: ${res.status}`);
    }

    const data = (await res.json()) as {
      events: RawTranscriptEvent[];
      nextCursor?: { eventNo: number };
    };

    all.push(...data.events);
    if (!data.nextCursor) break;
    cursorEventNo = data.nextCursor.eventNo;
  }

  return all;
}

/**
 * Fetch Hub message history for a thread.
 *
 * This is the canonical conversation timeline: it includes user turns and all
 * cat bubbles. Session transcripts are per-cat runtime logs and are used only
 * as supplemental event detail.
 */
async function fetchThreadMessages(threadId: string): Promise<ChatMessage[]> {
  const pages: ChatMessage[][] = [];
  const seenCursors = new Set<string>();
  let before: string | undefined;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const params = new URLSearchParams({ threadId, limit: '10000' });
    if (before) params.set('before', before);

    const res = await apiFetch(`/api/messages?${params.toString()}`);
    if (!res.ok) {
      throw new Error(`Failed to fetch thread messages: ${res.status}`);
    }
    const data = (await res.json()) as { messages?: ChatMessage[]; hasMore?: boolean };
    const messages = data.messages ?? [];

    if (messages.length > 0) pages.unshift(messages);
    if (!data.hasMore || messages.length === 0) break;

    const oldest = messages[0];
    const nextBefore = `${getMessageTimelineOrderTime(oldest)}:${oldest.id}`;
    if (seenCursors.has(nextBefore)) break;
    seenCursors.add(nextBefore);
    before = nextBefore;
  }

  return pages.flat();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch all events for a thread (all sessions + user messages, merged by timestamp).
 *
 * Flow:
 * 1. GET /api/threads/:threadId/sessions → list sessions
 * 2. For each session: paginate all events
 * 3. GET /api/messages → extract user (owner) messages
 * 4. Merge all + sort by timestamp + re-index eventNo
 */
export async function fetchThreadReplayEvents(threadId: string): Promise<RawTranscriptEvent[]> {
  const sessionIds = await fetchThreadSessionIds(threadId);

  const [messages, sessionEventSets] = await Promise.all([
    fetchThreadMessages(threadId),
    sessionIds.length > 0 ? Promise.all(sessionIds.map(fetchSessionEvents)) : Promise.resolve([]),
  ]);

  return mergeHubMessagesWithTranscriptSupplements(messages, mergeSessionEvents(sessionEventSets), threadId);
}
