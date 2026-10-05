/**
 * F322 original-B review findings (Sol6.1, #5015 typed changes_requested), pinned as regressions.
 *
 * P1-1 "show A, operate B": the row takes an explicit threadId. Its queue and pause state must come from THAT thread
 * (the same current-thread-or-threadStates rule thread liveness uses), never from whatever thread is current; with no
 * data for the target thread it shows and does nothing, it does not borrow the current thread's.
 *
 * P1-2 "a done write reported as failed": a reset whose POST succeeded is a success even when the follow-up re-read
 * throws. The family also covers the queue's 继续 (a re-read that throws must not read as "the request did not finish").
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';
import type { QueueEntry } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { useQueueActionConvergence } from '../../useQueueActionConvergence';
import { ExecutionRow } from '../ExecutionRow';
import { useQueueCommands } from '../useQueueCommands';
import { useQueueView } from '../useQueueView';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('@/hooks/useCatData', () => ({
  formatCatName: (cat: { displayName?: string; id: string }) => cat.displayName ?? cat.id,
  useCatData: () => ({
    cats: [],
    getCatById: (id: string) => ({ id, displayName: id, color: { primary: '#9B7EBD' } }),
  }),
}));

const A = 'thread-a';
const B = 'thread-b';

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function entry(id: string, threadId: string, over: Partial<QueueEntry> = {}): QueueEntry {
  return {
    id,
    threadId,
    userId: 'u1',
    content: `message ${id}`,
    messageId: `m-${id}`,
    mergedMessageIds: [],
    source: 'user',
    targetCats: ['opus'],
    intent: 'execute',
    status: 'queued',
    createdAt: Date.now(),
    ...over,
  };
}

const stuckIn = (threadId: string) =>
  entry('q-stuck', threadId, {
    status: 'processing',
    recoveryActions: [
      {
        id: 'queue-force-reset:q-stuck:1',
        entryId: 'q-stuck',
        kind: 'force_reset',
        request: { method: 'POST', path: `/api/threads/${threadId}/force-reset` },
      },
    ],
  });

const threadState = (queue: QueueEntry[], paused = false) => ({
  queue,
  queuePaused: paused,
  queuePauseReason: paused ? 'failed' : undefined,
  activeInvocations: {},
  catInvocations: {},
  catStatuses: {},
  hasActiveInvocation: false,
});

function seedCurrent(queue: QueueEntry[], paused = false, others: Record<string, unknown> = {}) {
  useActiveExecutionStore.getState().reset();
  useChatStore.setState({
    currentThreadId: A,
    messages: [],
    activeInvocations: {},
    catInvocations: {},
    catStatuses: {},
    hasActiveInvocation: false,
    queue,
    queuePaused: paused,
    queuePauseReason: paused ? 'canceled' : undefined,
    threadStates: others,
  } as never);
}

let commands: ReturnType<typeof useQueueCommands> | null = null;
let view: ReturnType<typeof useQueueView> | null = null;
function Harness({ threadId }: { threadId: string }) {
  const v = useQueueView(threadId);
  const convergence = useQueueActionConvergence(threadId);
  commands = useQueueCommands(threadId, v, convergence.refreshQueue);
  view = v;
  return null;
}

describe('the row operates the thread it shows', () => {
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
    mocks.apiFetch.mockImplementation(async () => json({ ok: true }));
    useToastStore.setState({ toasts: [] });
    commands = null;
    view = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const $ = (testId: string) => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  const click = (el: Element | null) => act(async () => (el as HTMLElement | null)?.click());
  const calls = () => mocks.apiFetch.mock.calls.map((c) => `${c[1]?.method ?? 'GET'} ${c[0] as string}`);
  const toastTitles = () => useToastStore.getState().toasts.map((t) => t.title);
  const dialogConfirm = () =>
    Array.from(document.querySelectorAll('[role="dialog"] button')).find((b) => b.textContent?.trim() === '强制重置');
  const renderRow = (threadId: string) => act(async () => root.render(<ExecutionRow threadId={threadId} />));

  describe('P1-1 queue and pause come from the row’s own thread', () => {
    it('a row for thread B shows B’s queue and pause, and its clear is sent to B', async () => {
      seedCurrent([entry('a-only', A)], false, {
        [B]: threadState([entry('b-one', B), entry('b-two', B)], true),
      });
      await renderRow(B);
      expect($('execution-row-text')?.textContent).toBe('排队已暂停 · 2 条');
      await click($('execution-row-toggle'));
      expect(container.textContent).toContain('message b-one');
      expect(container.textContent).not.toContain('message a-only');
      await click($('execution-row-queue-clear'));
      expect(calls()).toContain(`DELETE /api/threads/${B}/queue`);
      expect(calls()).not.toContain(`DELETE /api/threads/${A}/queue`);
    });

    it('A’s pause does not leak into a calm thread B', async () => {
      seedCurrent([entry('a-1', A)], true, { [B]: threadState([entry('b-one', B)], false) });
      await renderRow(B);
      expect($('execution-row-text')?.textContent).toBe('排队 1');
      // B's lone queued message has no live carrier, so the old rules offer 恢复 (orphaned) — never A's 继续 (paused).
      expect($('execution-row-resume')?.textContent).toBe('恢复');
    });

    it('control: the current thread is read from the flat state as before', async () => {
      seedCurrent([entry('a-1', A), entry('a-2', A)], true, { [B]: threadState([entry('b-one', B)]) });
      await renderRow(A);
      expect($('execution-row-text')?.textContent).toBe('排队已暂停 · 2 条');
    });

    it('with nothing known about thread B the row shows nothing and no command sends anything', async () => {
      seedCurrent([entry('a-only', A)], true, {});
      await renderRow(B);
      expect($('execution-row')).toBeNull();
      root.unmount();
      root = createRoot(container);
      await act(async () => root.render(<Harness threadId={B} />));
      expect(view?.queueKnown).toBe(false);
      await act(async () => {
        await commands?.handleClear();
        await commands?.handleContinue();
        await commands?.handleRemind('a-only', 'opus');
      });
      expect(calls()).toEqual([]);
    });
  });

  describe('P1-2 a write that went through is not reported as failed because the re-read did', () => {
    it('a projected stuck reset whose POST succeeded stays a success when GET /queue throws', async () => {
      mocks.apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
        if (path.endsWith('/force-reset')) return json({ ok: true });
        if (path.endsWith('/queue') && !init?.method) throw new Error('reread offline');
        return json({ ok: true });
      });
      seedCurrent([stuckIn(A)]);
      await renderRow(A);
      await click($('execution-row-force-reset'));
      await click(dialogConfirm() ?? null);
      expect(calls()).toContain(`POST /api/threads/${A}/force-reset`);
      expect(toastTitles()).toEqual(['已恢复']);
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    });

    it('negative control: a projected reset the server refuses still says 恢复未成功 and keeps the dialog', async () => {
      mocks.apiFetch.mockImplementation(async (path: string) =>
        path.endsWith('/force-reset') ? json({ error: 'PRESTART_STATE_CHANGED' }, 409) : json({ ok: true }),
      );
      seedCurrent([stuckIn(A)]);
      await renderRow(A);
      await click($('execution-row-force-reset'));
      await click(dialogConfirm() ?? null);
      expect(toastTitles()).toEqual(['恢复未成功']);
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    });

    it('negative control: a projected reset whose POST never completed still says 恢复未成功 and keeps the dialog', async () => {
      mocks.apiFetch.mockImplementation(async (path: string) => {
        if (path.endsWith('/force-reset')) throw new Error('network down');
        return json({ ok: true });
      });
      seedCurrent([stuckIn(A)]);
      await renderRow(A);
      await click($('execution-row-force-reset'));
      await click(dialogConfirm() ?? null);
      expect(toastTitles()).toEqual(['恢复未成功']);
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    });

    it('继续: a queue/next that did not start and a re-read that throws reads as "not started", not "request failed"', async () => {
      mocks.apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
        if (path.endsWith('/queue/next')) return json({ started: false }, 200);
        if (path.endsWith('/queue') && !init?.method) throw new Error('reread offline');
        return json({ ok: true });
      });
      seedCurrent([entry('a-1', A)], true);
      await renderRow(A);
      await click($('execution-row-resume'));
      expect(toastTitles()).toEqual(['队列未启动']);
    });
  });
});
