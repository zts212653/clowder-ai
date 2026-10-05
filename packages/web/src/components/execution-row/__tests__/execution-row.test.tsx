/**
 * F322 original-B: the one row presses the SAME endpoints, with the SAME bodies, as the surfaces it will replace.
 *
 * Preservation-matrix rows covered here (row number = docs/plans matrix): 1 stop one live run, 2 stop one managed
 * command, 4 cannot-stop reasons, 6 force reset (abnormal classes), 13 clear queue, 14 resume, 15 recover a stuck
 * entry, 17 pause display, 7 stale hydration. Rows that only reuse QueueEntryRow (remind, steer, recall-edit,
 * withdraw, retry, reorder) are covered by the existing queue-panel-* suites, which run against the SAME
 * QueueEntryList through QueuePanel.
 */
import type { ActiveExecutionProjection } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';
import type { CatStatusType, QueueEntry } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { ExecutionRow } from '../ExecutionRow';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('@/hooks/useCatData', () => ({
  formatCatName: (cat: { displayName?: string; id: string }) => cat.displayName ?? cat.id,
  useCatData: () => ({
    cats: [],
    getCatById: (id: string) => ({ id, displayName: id, color: { primary: '#9B7EBD' } }),
  }),
}));

const THREAD = 'thread-a';
const NOW = Date.now();

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function run(catId: string, over: Partial<ActiveExecutionProjection> = {}): ActiveExecutionProjection {
  return {
    executionId: `exec-${catId}`,
    threadId: THREAD,
    threadTitle: 'Alpha',
    catId,
    kind: 'live_invocation',
    startedAt: NOW - 90_000,
    cancelability: {
      state: 'cancelable',
      target: { kind: 'live_invocation', threadId: THREAD, catId, executionId: `exec-${catId}` },
    },
    ...over,
  };
}

function entry(id: string, over: Partial<QueueEntry> = {}): QueueEntry {
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
    createdAt: NOW,
    ...over,
  };
}

function seed(options: {
  executions?: ActiveExecutionProjection[];
  catStatuses?: Record<string, CatStatusType>;
  queue?: QueueEntry[];
  paused?: boolean;
  hydration?: 'ready' | 'error';
}) {
  const store = useActiveExecutionStore.getState();
  const version = store.beginHydration(THREAD, '/project/cafe');
  useActiveExecutionStore
    .getState()
    .applySnapshot(THREAD, version, { projectPath: '/project/cafe', executions: options.executions ?? [] });
  if (options.hydration === 'error') {
    const failing = useActiveExecutionStore.getState().beginHydration(THREAD, '/project/cafe');
    useActiveExecutionStore.getState().failHydration(THREAD, failing, new Error('boom'));
  }
  const live = options.executions?.filter((e) => e.kind === 'live_invocation') ?? [];
  useChatStore.setState({
    currentThreadId: THREAD,
    activeInvocations: Object.fromEntries(live.map((e) => [e.executionId, { catId: e.catId, startedAt: e.startedAt }])),
    hasActiveInvocation: live.length > 0,
    catStatuses: options.catStatuses ?? {},
    catInvocations: {},
    threadStates: {},
    queue: options.queue ?? [],
    queuePaused: options.paused ?? false,
    queuePauseReason: options.paused ? 'canceled' : undefined,
  } as never);
}

describe('ExecutionRow (F322 original-B)', () => {
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
    useActiveExecutionStore.getState().reset();
    useToastStore.setState({ toasts: [] });
    mocks.apiFetch.mockReset();
    mocks.apiFetch.mockImplementation(async () => json({ ok: true }));
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
  const render = () => act(async () => root.render(<ExecutionRow threadId={THREAD} />));
  const calls = () => mocks.apiFetch.mock.calls.map((c) => `${c[1]?.method ?? 'GET'} ${c[0] as string}`);
  const toastTitles = () => useToastStore.getState().toasts.map((t) => t.title);
  const dialogConfirm = () =>
    Array.from(document.querySelectorAll('[role="dialog"] button')).find((b) => b.textContent?.trim() === '强制重置');

  it('takes no space when there is nothing to say', async () => {
    seed({});
    await render();
    expect($('execution-row')).toBeNull();
  });

  it('1  ■ stops the single live run through the same cancel endpoint and body, then re-reads executions', async () => {
    seed({ executions: [run('opus')] });
    await render();
    expect($('execution-row-text')?.textContent).toMatch(/^opus 正在工作 \d+:\d{2}$/);
    await click($('execution-row-stop')?.querySelector('button') ?? null);
    const cancel = mocks.apiFetch.mock.calls.find((c) => String(c[0]).endsWith('/cancel'));
    expect(cancel?.[0]).toBe(`/api/threads/${THREAD}/executions/live/exec-opus/cancel`);
    expect(cancel?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ catId: 'opus' }) });
    expect(calls()).toContain('GET /api/executions/active?projectPath=%2Fproject%2Fcafe');
  });

  it('2  ■ on a managed command deletes the hold-ball task', async () => {
    const managed = run('opus', {
      kind: 'managed_command',
      executionId: 'task-9',
      activity: 'build',
      cancelability: { state: 'cancelable', target: { kind: 'managed_command', taskId: 'task-9' } },
    });
    seed({ executions: [managed] });
    await render();
    await click($('execution-row-stop')?.querySelector('button') ?? null);
    expect(calls()).toContain('DELETE /api/callbacks/hold-ball/task-9');
  });

  it('4  a run you cannot stop shows its reason instead of a ■, and nothing can be pressed to stop it', async () => {
    seed({
      executions: [
        run('opus', {
          kind: 'managed_command',
          activity: 'full_gate',
          cancelability: { state: 'not_cancelable', reason: 'foreign_principal' },
        }),
      ],
    });
    await render();
    expect($('execution-row-stop')).toBeNull();
    expect($('execution-row-text')?.textContent).toContain('全量门禁 · 不是你发起的，你不能停');
  });

  it('6  a quiet turn floats 强制重置; confirming posts the thread endpoint and says 已重置 only on success', async () => {
    seed({ executions: [run('opus')], catStatuses: { opus: 'suspected_stall' } });
    await render();
    expect($('execution-row')?.getAttribute('data-status')).toBe('silent');
    await click($('execution-row-force-reset'));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('会保留什么');
    await click(dialogConfirm() ?? null);
    expect(calls()).toContain(`POST /api/threads/${THREAD}/force-reset`);
    expect(toastTitles()).toEqual(['已重置']);
  });

  it('6b a force-reset the server refuses is NOT reported as done (the old bar said 已重置 on a 409)', async () => {
    mocks.apiFetch.mockImplementation(async (path: string) =>
      path.endsWith('/force-reset') ? json({ error: 'PRESTART_STATE_CHANGED' }, 409) : json({ ok: true }),
    );
    seed({ executions: [run('opus')], catStatuses: { opus: 'suspected_stall' } });
    await render();
    await click($('execution-row-force-reset'));
    await click(dialogConfirm() ?? null);
    expect(toastTitles()).toEqual(['恢复未成功']);
    expect(useToastStore.getState().toasts[0].message).toBe('PRESTART_STATE_CHANGED');
    // The dialog stays open so the user can try again or cancel.
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('6c a healthy run floats no reset', async () => {
    seed({ executions: [run('opus')], catStatuses: { opus: 'streaming' } });
    await render();
    expect($('execution-row-force-reset')).toBeNull();
  });

  it('15 a stuck message runs its projected action through the queue convergence (same request, same toast)', async () => {
    const stuck = entry('q-stuck', {
      status: 'processing',
      recoveryActions: [
        {
          id: 'queue-force-reset:q-stuck:1',
          entryId: 'q-stuck',
          kind: 'force_reset',
          request: { method: 'POST', path: `/api/threads/${THREAD}/force-reset` },
        },
      ],
    });
    seed({ queue: [stuck] });
    await render();
    expect($('execution-row-text')?.textContent).toBe('1 件处理卡住');
    await click($('execution-row-force-reset'));
    await click(dialogConfirm() ?? null);
    expect(calls()).toContain(`POST /api/threads/${THREAD}/force-reset`);
    expect(calls()).toContain(`GET /api/threads/${THREAD}/queue`);
    expect(toastTitles()).toEqual(['已恢复']);
  });

  it('15b with a stuck message the row offers 强制重置 only; 恢复 waits in the panel header', async () => {
    const stuck = entry('q-stuck', {
      status: 'processing',
      recoveryActions: [
        {
          id: 'queue-force-reset:q-stuck:1',
          entryId: 'q-stuck',
          kind: 'force_reset',
          request: { method: 'POST', path: `/api/threads/${THREAD}/force-reset` },
        },
      ],
    });
    seed({ queue: [stuck, entry('a')] });
    await render();
    expect($('execution-row-force-reset')).not.toBeNull();
    expect($('execution-row-resume')).toBeNull();
    await click($('execution-row-toggle'));
    expect($('execution-row-queue-resume')?.textContent).toBe('恢复');
  });

  it('14/17 a paused queue says so, keeps the reason, and 继续 posts queue/next', async () => {
    seed({ queue: [entry('a'), entry('b')], paused: true });
    await render();
    expect($('execution-row-text')?.textContent).toBe('排队已暂停 · 2 条');
    expect($('execution-row-text')?.getAttribute('title')).toBe('当前调用已取消');
    mocks.apiFetch.mockImplementation(async () => json({ started: true }));
    await click($('execution-row-resume'));
    expect(calls()).toContain(`POST /api/threads/${THREAD}/queue/next`);
  });

  it('7  a stale projection is said, next to the run it may be wrong about', async () => {
    seed({ executions: [run('opus')], hydration: 'error' });
    await render();
    expect($('execution-row-stale')?.textContent).toBe('状态暂不可核对');
  });

  it('13 the panel clears the queue through the same DELETE, and Esc / an outside press close it', async () => {
    seed({ executions: [run('opus')], queue: [entry('a'), entry('b')] });
    await render();
    expect($('execution-row-panel')).toBeNull();
    await click($('execution-row-toggle'));
    expect($('execution-row-panel')).not.toBeNull();
    await click($('execution-row-queue-clear'));
    expect(calls()).toContain(`DELETE /api/threads/${THREAD}/queue`);

    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect($('execution-row-panel')).toBeNull();

    await click($('execution-row-toggle'));
    expect($('execution-row-panel')).not.toBeNull();
    await act(async () => document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
    expect($('execution-row-panel')).toBeNull();
  });

  it("12 withdraw inside the new panel presses the entry's own projected DELETE (same words as the old panel)", async () => {
    const queued = entry('q1', {
      recoveryActions: [
        {
          id: 'queue-withdraw:q1',
          entryId: 'q1',
          kind: 'withdraw',
          request: { method: 'DELETE', path: `/api/threads/${THREAD}/queue/q1` },
        },
      ],
    });
    seed({ queue: [queued] });
    await render();
    await click($('execution-row-toggle'));
    await click(container.querySelector('[aria-label="停止后续处理"]'));
    expect(calls()).toContain(`DELETE /api/threads/${THREAD}/queue/q1`);
    expect(toastTitles()).toEqual(['已停止后续处理']);
  });

  it('10 steer inside the new panel asks first, and only the confirmation posts', async () => {
    const queued = entry('q1', {
      recoveryActions: [
        {
          id: 'queue-steer:q1',
          entryId: 'q1',
          kind: 'steer',
          request: { method: 'POST', path: `/api/threads/${THREAD}/queue/q1/steer` },
        },
      ],
    });
    seed({ queue: [queued] });
    await render();
    await click($('execution-row-toggle'));
    await click($('steer-q1'));
    expect(calls().filter((c) => c.endsWith('/steer'))).toEqual([]);
    expect($('steer-confirm')).not.toBeNull();
    await click($('steer-confirm'));
    expect(calls()).toContain(`POST /api/threads/${THREAD}/queue/q1/steer`);
  });

  it('3  several runs: no single ■ on the row; each run has its own in the panel', async () => {
    seed({ executions: [run('opus'), run('codex')] });
    await render();
    expect($('execution-row-text')?.textContent).toBe('2 件在跑');
    expect($('execution-row-stop')).toBeNull();
    await click($('execution-row-toggle'));
    const rows = container.querySelectorAll('[data-testid="execution-row-run"]');
    expect(rows).toHaveLength(2);
    const codexRow = Array.from(rows).find((row) => row.textContent?.includes('codex'));
    await click(codexRow?.querySelector('button') ?? null);
    const cancels = mocks.apiFetch.mock.calls.filter((c) => String(c[0]).endsWith('/cancel')).map((c) => c[0]);
    expect(cancels).toEqual([`/api/threads/${THREAD}/executions/live/exec-codex/cancel`]);
  });

  it('opening the panel never changes the height of the row itself', async () => {
    seed({ executions: [run('opus')], queue: [entry('a')] });
    await render();
    const bar = () => $('execution-row')?.firstElementChild as HTMLElement;
    const before = bar().className;
    await click($('execution-row-toggle'));
    expect(bar().className).toBe(before);
    // The panel is out of flow (absolute), so it cannot push the conversation.
    expect($('execution-row-panel')?.className).toContain('absolute');
  });
});
