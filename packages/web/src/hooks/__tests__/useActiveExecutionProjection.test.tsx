import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(
    async () => new Response(JSON.stringify({ projectPath: '/project/cafe', executions: [] }), { status: 200 }),
  ),
}));

vi.mock('@/utils/api-client', () => ({ apiFetch: mocks.apiFetch }));

import { useActiveExecutionProjection } from '../useActiveExecutionProjection';

function Harness({ threadId, connected }: { threadId: string; connected: boolean | null }) {
  useActiveExecutionProjection(threadId, connected);
  return null;
}

describe('F295 canonical execution hydration', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.apiFetch.mockClear();
    useActiveExecutionStore.getState().reset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('hydrates on first mount, reconnect, navigation, and bounded cold-discovery polling', async () => {
    await act(async () => {
      root.render(<Harness threadId="thread-a" connected={false} />);
    });
    expect(mocks.apiFetch).toHaveBeenLastCalledWith('/api/threads/thread-a/executions/active', {
      signal: expect.any(AbortSignal),
    });

    await act(async () => {
      root.render(<Harness threadId="thread-a" connected />);
    });
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(4_000);
    });
    expect(mocks.apiFetch).toHaveBeenCalledTimes(3);

    await act(async () => {
      root.render(<Harness threadId="thread-b" connected />);
    });
    expect(mocks.apiFetch).toHaveBeenLastCalledWith('/api/threads/thread-b/executions/active', {
      signal: expect.any(AbortSignal),
    });
  });
});
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});
