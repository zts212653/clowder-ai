import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { useChatStore } from '@/stores/chatStore';
import { ThreadExecutionBar } from '../ThreadExecutionBar';

/**
 * Recovery escape hatch for the canonical-empty + legacy-unverified deadlock.
 *
 * When a turn dies without a terminal socket event (observed with a CLI
 * `exit: null` after an upstream 529), the legacy socket slot stays lit while the
 * canonical execution projection never reaches `ready` for this thread. Two
 * independently reasonable fail-closed decisions then combine into a trap:
 * ChatInput hard-locks Cancel to `unavailable`, and ThreadExecutionBar returns
 * null on an empty canonical list — which also removes the force-reset entry,
 * the only escape. The backend force-reset endpoint is healthy; the UI simply
 * offers no door.
 */
const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(async () => new Response('{"ok":true,"canceledRecords":1}', { status: 200 })),
  addToast: vi.fn(),
}));

vi.mock('@/hooks/useCatData', () => ({
  formatCatName: (cat: { displayName?: string; id: string }) => cat.displayName ?? cat.id,
  useCatData: () => ({ getCatById: (id: string) => ({ id, displayName: id, color: { primary: '#9B7EBD' } }) }),
}));
vi.mock('@/utils/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('@/stores/toastStore', () => ({
  useToastStore: { getState: () => ({ addToast: mocks.addToast }) },
}));

/** Legacy socket still reports a live turn; canonical projection never covers this thread. */
function setUnverifiedLegacyOnly() {
  useChatStore.setState({
    currentThreadId: 'thread-a',
    activeInvocations: { 'inv-a': { catId: 'opus', mode: 'execute', startedAt: 1000 } },
    hasActiveInvocation: true,
    intentMode: 'execute',
    targetCats: ['opus'],
    catStatuses: { opus: 'streaming' },
    catInvocations: {},
    threadStates: {},
  });
}

describe('ThreadExecutionBar — canonical-empty + legacy-unverified recovery', () => {
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
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('keeps the force-reset escape hatch reachable when canonical is empty but legacy is unverified', () => {
    setUnverifiedLegacyOnly();
    act(() => {
      root.render(React.createElement(ThreadExecutionBar, { threadId: 'thread-a' }));
    });

    const entry = container.querySelector('[data-testid="force-reset-entry"]');
    expect(entry).not.toBeNull();
  });

  it('force-reset actually reaches the backend from that state', async () => {
    setUnverifiedLegacyOnly();
    act(() => {
      root.render(React.createElement(ThreadExecutionBar, { threadId: 'thread-a' }));
    });

    const entry = container.querySelector('[data-testid="force-reset-entry"]') as HTMLButtonElement;
    await act(async () => {
      entry.click();
    });
    const confirmBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === '强制重置',
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      confirmBtn?.click();
    });

    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/threads/thread-a/force-reset', { method: 'POST' });
  });

  it('stays hidden when neither canonical nor legacy reports anything (no permanent bar)', () => {
    useChatStore.setState({
      currentThreadId: 'thread-a',
      activeInvocations: {},
      hasActiveInvocation: false,
      catStatuses: {},
      catInvocations: {},
      threadStates: {},
    });
    act(() => {
      root.render(React.createElement(ThreadExecutionBar, { threadId: 'thread-a' }));
    });

    expect(container.querySelector('[data-testid="force-reset-entry"]')).toBeNull();
    expect(container.textContent).toBe('');
  });
});
