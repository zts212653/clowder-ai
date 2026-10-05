/**
 * F322 original-B: a question the row is waiting on belongs to the thread it was asked about. The footer re-renders when
 * the chat switches to another thread; a "强制重置这个对话？" dialog (or a steer confirmation) opened for A must not
 * survive as a question about B and must never send B a request. Same-thread behaviour is unchanged.
 */
import type { ActiveExecutionProjection } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { useChatStore } from '@/stores/chatStore';
import { SHELL_PRESENTATION_STORAGE_KEY, writeShellPresentation } from '../../shell/shell-presentation';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('@/hooks/useCatData', () => ({
  formatCatName: (cat: { displayName?: string; id: string }) => cat.displayName ?? cat.id,
  useCatData: () => ({
    cats: [],
    getCatById: (id: string) => ({ id, displayName: id, color: { primary: '#9B7EBD' } }),
  }),
}));

import { ThreadExecutionLayer } from '../ThreadExecutionLayer';

const A = 'thread-a';
const B = 'thread-b';
const NOW = Date.now();

function run(threadId: string): ActiveExecutionProjection {
  return {
    executionId: `exec-${threadId}`,
    threadId,
    threadTitle: threadId,
    catId: 'opus',
    kind: 'live_invocation',
    startedAt: NOW - 90_000,
    cancelability: {
      state: 'cancelable',
      target: { kind: 'live_invocation', threadId, catId: 'opus', executionId: `exec-${threadId}` },
    },
  };
}

describe('ThreadExecutionLayer (v2): pending confirmations are scoped to their thread', () => {
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
    window.localStorage.removeItem(SHELL_PRESENTATION_STORAGE_KEY);
    mocks.apiFetch.mockReset();
    mocks.apiFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
    const store = useActiveExecutionStore.getState();
    store.reset();
    const version = store.beginHydration(A, '/project/cafe');
    useActiveExecutionStore
      .getState()
      .applySnapshot(A, version, { projectPath: '/project/cafe', executions: [run(A), run(B)] });
    // A is the thread on screen and its run has gone quiet, so its row floats 强制重置.
    useChatStore.setState({
      currentThreadId: A,
      activeInvocations: { [`exec-${A}`]: { catId: 'opus', startedAt: NOW - 90_000 } },
      hasActiveInvocation: true,
      catStatuses: { opus: 'suspected_stall' },
      catInvocations: {},
      threadStates: {},
      queue: [],
      queuePaused: false,
    } as never);
    act(() => writeShellPresentation('v2'));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.localStorage.removeItem(SHELL_PRESENTATION_STORAGE_KEY);
    useActiveExecutionStore.getState().reset();
  });

  const $ = (testId: string) => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  const click = (el: Element | null) => act(async () => (el as HTMLElement | null)?.click());
  const render = (threadId: string) => act(async () => root.render(<ThreadExecutionLayer threadId={threadId} />));
  const dialog = () => document.querySelector('[role="dialog"]');
  const confirm = () =>
    Array.from(document.querySelectorAll('[role="dialog"] button')).find((b) => b.textContent?.trim() === '强制重置');
  const resets = () => mocks.apiFetch.mock.calls.filter((c) => String(c[0]).endsWith('/force-reset'));

  it('control: the question opened on A and confirmed on A resets A', async () => {
    await render(A);
    await click($('execution-row-force-reset'));
    expect(dialog()).not.toBeNull();
    await click(confirm() ?? null);
    expect(resets().map((c) => c[0])).toEqual([`/api/threads/${A}/force-reset`]);
  });

  it('the question opened on A is dropped when the footer moves to B: nothing to confirm, no request to B', async () => {
    await render(A);
    await click($('execution-row-force-reset'));
    expect(dialog()).not.toBeNull();
    await render(B);
    expect($('execution-row')).not.toBeNull();
    expect(dialog()).toBeNull();
    await click(confirm() ?? null);
    expect(resets()).toEqual([]);
  });
});
