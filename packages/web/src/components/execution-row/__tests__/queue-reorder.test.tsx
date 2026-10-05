/**
 * F322 original-B: dragging queued messages while a stuck message is also on show.
 *
 * `PATCH /api/threads/:t/queue/reorder` answers 400 "Cannot reorder entry … (processing)" for any processing entry in
 * `positions` (packages/api/src/routes/queue.ts). The visible list includes a stuck processing entry, so a reorder
 * that sent every visible id failed whenever a stuck message was on screen — the moment the user is trying to recover.
 * Only queued entries may be reordered; a processing one is neither draggable nor a drop target.
 */
import type { DragEndEvent } from '@dnd-kit/core';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueEntry } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { useQueueActionConvergence } from '../../useQueueActionConvergence';
import { useQueueCommands } from '../useQueueCommands';
import { useQueueView } from '../useQueueView';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: mocks.apiFetch }));

const THREAD = 'thread-1';

function entry(id: string, createdAt: number, over: Partial<QueueEntry> = {}): QueueEntry {
  return {
    id,
    threadId: THREAD,
    userId: 'u1',
    content: `message ${id}`,
    messageId: `m-${id}`,
    mergedMessageIds: [],
    source: 'user',
    targetCats: ['opus'],
    intent: 'execute',
    status: 'queued',
    createdAt,
    ...over,
  };
}

const STUCK = entry('stuck', 1, {
  status: 'processing',
  recoveryActions: [
    {
      id: 'queue-force-reset:stuck:1',
      entryId: 'stuck',
      kind: 'force_reset',
      request: { method: 'POST', path: `/api/threads/${THREAD}/force-reset` },
    },
  ],
});

let commands: ReturnType<typeof useQueueCommands> | null = null;

function Harness() {
  const view = useQueueView(THREAD);
  const convergence = useQueueActionConvergence(THREAD);
  commands = useQueueCommands(THREAD, view, convergence.refreshQueue);
  return null;
}

const drag = (active: string, over: string) =>
  ({ active: { id: active }, over: { id: over } }) as unknown as DragEndEvent;
const lastPatchBody = () => {
  const call = mocks.apiFetch.mock.calls.find((c) => c[1]?.method === 'PATCH');
  return call ? { path: call[0] as string, body: JSON.parse(call[1].body as string) } : null;
};

describe('reordering the queue while a stuck message is on show', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  beforeEach(() => {
    mocks.apiFetch.mockReset();
    mocks.apiFetch.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }));
    commands = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useChatStore.setState({
      currentThreadId: THREAD,
      messages: [],
      activeInvocations: {},
      catInvocations: {},
      queue: [STUCK, entry('a', 2), entry('b', 3)],
      queuePaused: false,
    } as never);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('sends only queued entries: the server refuses a processing one with a 400', async () => {
    await act(async () => root.render(<Harness />));
    await act(async () => commands?.handleDragEnd(drag('b', 'a')));
    expect(lastPatchBody()).toEqual({
      path: `/api/threads/${THREAD}/queue/reorder`,
      body: {
        positions: [
          { entryId: 'b', position: 0 },
          { entryId: 'a', position: 1 },
        ],
      },
    });
  });

  it('dropping on the stuck message does nothing', async () => {
    await act(async () => root.render(<Harness />));
    await act(async () => commands?.handleDragEnd(drag('a', 'stuck')));
    expect(lastPatchBody()).toBeNull();
  });
});
