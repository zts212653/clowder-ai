import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  addToast: vi.fn(),
}));

vi.mock('@/utils/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('@/stores/toastStore', () => ({
  useToastStore: { getState: () => ({ addToast: mocks.addToast }) },
}));

import { useLiveExecutionCancelControl } from '../useLiveExecutionCancelControl';

let observed: ReturnType<typeof useLiveExecutionCancelControl> | null = null;

function Harness() {
  observed = useLiveExecutionCancelControl('thread-a', [{ executionId: 'legacy-inv', catId: 'opus' }]);
  return null;
}

describe('useLiveExecutionCancelControl legacy Stop ladder', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.apiFetch.mockReset();
    mocks.addToast.mockReset();
    useActiveExecutionStore.getState().reset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<Harness />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    observed = null;
    vi.useRealTimers();
  });

  it('keeps Stop available and reconciles a legacy-only execution through the exact endpoint', async () => {
    mocks.apiFetch.mockImplementation(async (url: string) =>
      url.includes('/cancel')
        ? new Response(JSON.stringify({ ok: true, reconciled: true }), { status: 200 })
        : new Response(JSON.stringify({ projectPath: '/project/cafe', executions: [] }), { status: 200 }),
    );

    expect(observed?.state).toBe('available');
    await act(async () => observed?.cancelAll());

    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/threads/thread-a/executions/live/legacy-inv/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ catId: 'opus' }),
    });
  });
});

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});
