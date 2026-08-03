/**
 * F252 Phase E — Thread-level session event merging
 *
 * Tests the pure merge function that combines events from multiple sessions
 * into a single sorted timeline for thread-level replay.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { adaptTranscriptEvents } from '../adapter';
import { mergeSessionEvents } from '../merge-session-events';
import { buildReplayChatMessages } from '../replay-chat-bridge';
import { fetchThreadReplayEvents } from '../thread-replay-fetcher';
import type { RawTranscriptEvent } from '../types';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));

const apiFetchMock = vi.mocked(apiFetch);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRawEvent(overrides: Partial<RawTranscriptEvent> = {}): RawTranscriptEvent {
  return {
    v: 1,
    t: 1000,
    threadId: 'thread_1',
    catId: 'opus',
    sessionId: 'session_1',
    cliSessionId: 'cli_1',
    eventNo: 0,
    event: { type: 'text' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  apiFetchMock.mockReset();
});

describe('mergeSessionEvents', () => {
  it('merges events from multiple sessions sorted by timestamp (INV-5)', () => {
    const session1 = [
      makeRawEvent({ t: 1000, eventNo: 0, sessionId: 'a', catId: 'opus' }),
      makeRawEvent({ t: 3000, eventNo: 1, sessionId: 'a', catId: 'opus' }),
    ];
    const session2 = [
      makeRawEvent({ t: 2000, eventNo: 0, sessionId: 'b', catId: 'codex' }),
      makeRawEvent({ t: 4000, eventNo: 1, sessionId: 'b', catId: 'codex' }),
    ];

    const merged = mergeSessionEvents([session1, session2]);

    // Sorted by t
    expect(merged.map((e) => e.t)).toEqual([1000, 2000, 3000, 4000]);
    // Interleaved session IDs
    expect(merged.map((e) => e.sessionId)).toEqual(['a', 'b', 'a', 'b']);
  });

  it('re-indexes eventNo monotonically after merge', () => {
    const session1 = [makeRawEvent({ t: 2000, eventNo: 0 })];
    const session2 = [makeRawEvent({ t: 1000, eventNo: 0 })];

    const merged = mergeSessionEvents([session1, session2]);

    expect(merged[0].eventNo).toBe(0);
    expect(merged[1].eventNo).toBe(1);
  });

  it('handles empty session list', () => {
    expect(mergeSessionEvents([])).toEqual([]);
  });

  it('handles single session passthrough', () => {
    const events = [makeRawEvent({ t: 1000, eventNo: 0 }), makeRawEvent({ t: 2000, eventNo: 1 })];

    const merged = mergeSessionEvents([events]);

    expect(merged).toHaveLength(2);
    expect(merged[0].t).toBe(1000);
    expect(merged[1].t).toBe(2000);
  });

  it('handles sessions with empty event arrays', () => {
    const merged = mergeSessionEvents([[], [], []]);
    expect(merged).toEqual([]);
  });

  it('preserves all original fields except re-indexed eventNo', () => {
    const event = makeRawEvent({
      t: 5000,
      eventNo: 42,
      catId: 'codex',
      sessionId: 'sess_abc',
      invocationId: 'inv_xyz',
      event: { type: 'tool_use', toolName: 'Read' },
    });

    const merged = mergeSessionEvents([[event]]);

    expect(merged[0].catId).toBe('codex');
    expect(merged[0].sessionId).toBe('sess_abc');
    expect(merged[0].invocationId).toBe('inv_xyz');
    expect(merged[0].event).toEqual({ type: 'tool_use', toolName: 'Read' });
    // eventNo re-indexed
    expect(merged[0].eventNo).toBe(0);
  });

  it('handles many sessions with overlapping timestamps', () => {
    const sessions = Array.from({ length: 5 }, (_, i) => [
      makeRawEvent({ t: 1000 + i * 100, eventNo: 0, sessionId: `s${i}` }),
      makeRawEvent({ t: 2000 + i * 100, eventNo: 1, sessionId: `s${i}` }),
    ]);

    const merged = mergeSessionEvents(sessions);

    expect(merged).toHaveLength(10);
    // Timestamps should be monotonically non-decreasing
    for (let i = 1; i < merged.length; i++) {
      expect(merged[i].t).toBeGreaterThanOrEqual(merged[i - 1].t);
    }
    // eventNo should be 0..9
    expect(merged.map((e) => e.eventNo)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('is stable sort — preserves relative order of same-timestamp events', () => {
    const events = [
      makeRawEvent({ t: 1000, eventNo: 0, sessionId: 'first' }),
      makeRawEvent({ t: 1000, eventNo: 1, sessionId: 'second' }),
      makeRawEvent({ t: 1000, eventNo: 2, sessionId: 'third' }),
    ];

    const merged = mergeSessionEvents([events]);

    // Same-timestamp events keep original order
    expect(merged.map((e) => e.sessionId)).toEqual(['first', 'second', 'third']);
  });
});

describe('fetchThreadReplayEvents', () => {
  it('prefers Hub message history over single-cat transcript speech', async () => {
    apiFetchMock.mockImplementation(async (url) => {
      const path = String(url);

      if (path === '/api/threads/thread_1/sessions') {
        return new Response(JSON.stringify({ sessions: [{ id: 'session_opus', status: 'sealed' }] }), { status: 200 });
      }

      if (path === '/api/messages?threadId=thread_1&limit=10000') {
        return new Response(
          JSON.stringify({
            messages: [
              { id: 'msg_user', type: 'user', content: '我呢？', timestamp: 1000 },
              { id: 'msg_opus', type: 'assistant', catId: 'opus', content: 'Opus says', timestamp: 1100 },
              { id: 'msg_codex', type: 'assistant', catId: 'codex', content: 'Codex says', timestamp: 1200 },
            ],
          }),
          { status: 200 },
        );
      }

      if (path === '/api/sessions/session_opus/events?view=raw&limit=200') {
        return new Response(
          JSON.stringify({
            events: [
              makeRawEvent({
                t: 1100,
                eventNo: 0,
                sessionId: 'session_opus',
                catId: 'opus',
                event: { type: 'text', content: 'duplicate transcript speech' },
              }),
              makeRawEvent({
                t: 1150,
                eventNo: 1,
                sessionId: 'session_opus',
                catId: 'opus',
                event: { type: 'system_info', content: JSON.stringify({ type: 'silent_completion' }) },
              }),
            ],
          }),
          { status: 200 },
        );
      }

      throw new Error(`Unexpected request: ${path}`);
    });

    const events = await fetchThreadReplayEvents('thread_1');
    const replayMessages = buildReplayChatMessages(adaptTranscriptEvents(events));

    const narrativeMessages = replayMessages.filter((message) => message.type !== 'system');
    expect(narrativeMessages.map((message) => [message.type, message.catId, message.content])).toEqual([
      ['user', undefined, '我呢？'],
      ['assistant', 'opus', 'Opus says'],
      ['assistant', 'codex', 'Codex says'],
    ]);
    expect(events.some((event) => event.event.content === 'duplicate transcript speech')).toBe(false);
  });

  it('paginates Hub message history before suppressing transcript speech', async () => {
    apiFetchMock.mockImplementation(async (url) => {
      const path = String(url);

      if (path === '/api/threads/thread_1/sessions') {
        return new Response(JSON.stringify({ sessions: [{ id: 'session_opus', status: 'sealed' }] }), { status: 200 });
      }

      if (path === '/api/messages?threadId=thread_1&limit=10000') {
        return new Response(
          JSON.stringify({
            messages: [
              { id: 'new_user', type: 'user', content: 'newer user', timestamp: 2000, deliveredAt: 9000 },
              { id: 'new_opus', type: 'assistant', catId: 'opus', content: 'newer opus', timestamp: 2100 },
            ],
            hasMore: true,
          }),
          { status: 200 },
        );
      }

      if (path === '/api/messages?threadId=thread_1&limit=10000&before=9000%3Anew_user') {
        return new Response(
          JSON.stringify({
            messages: [
              { id: 'old_user', type: 'user', content: 'older user', timestamp: 1000 },
              { id: 'old_codex', type: 'assistant', catId: 'codex', content: 'older codex', timestamp: 1100 },
            ],
            hasMore: false,
          }),
          { status: 200 },
        );
      }

      if (path === '/api/sessions/session_opus/events?view=raw&limit=200') {
        return new Response(
          JSON.stringify({
            events: [
              makeRawEvent({
                t: 1000,
                eventNo: 0,
                sessionId: 'session_opus',
                catId: 'opus',
                event: { type: 'text', content: 'older transcript duplicate' },
              }),
            ],
          }),
          { status: 200 },
        );
      }

      throw new Error(`Unexpected request: ${path}`);
    });

    const events = await fetchThreadReplayEvents('thread_1');
    const replayMessages = buildReplayChatMessages(adaptTranscriptEvents(events));

    expect(replayMessages.map((message) => [message.type, message.catId, message.content])).toEqual([
      ['user', undefined, 'older user'],
      ['assistant', 'codex', 'older codex'],
      ['assistant', 'opus', 'newer opus'],
      ['user', undefined, 'newer user'],
    ]);
    expect(events.some((event) => event.event.content === 'older transcript duplicate')).toBe(false);
  });
});
