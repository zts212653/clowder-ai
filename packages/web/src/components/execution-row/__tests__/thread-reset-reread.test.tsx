/** Thread reset has one outcome even when the following Queue refresh fails. */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useToastStore } from '@/stores/toastStore';
import { useQueueActionConvergence } from '../../useQueueActionConvergence';
import { useRowForceReset } from '../useRowForceReset';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: mocks.apiFetch }));

const THREAD = 'thread-t';

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

let reset: ReturnType<typeof useRowForceReset> | null = null;
function Harness() {
  const convergence = useQueueActionConvergence(THREAD);
  reset = useRowForceReset({ threadId: THREAD, convergence });
  return null;
}

let container: HTMLDivElement;
let root: Root;
const priorActEnv = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = priorActEnv;
});
beforeEach(() => {
  mocks.apiFetch.mockReset();
  mocks.apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
    if (path.endsWith('/force-reset')) return json({ ok: true });
    if (path.endsWith('/queue') && !init?.method) throw new Error('re-read offline');
    return json({ ok: true });
  });
  useToastStore.setState({ toasts: [] } as never);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  reset = null;
});

const toastTitles = () => useToastStore.getState().toasts.map((toast) => toast.title);

async function confirmReset() {
  await act(async () => root.render(<Harness />));
  await act(async () => reset?.request());
  await act(async () => {
    reset?.dialog.onConfirm();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('thread reset followed by an offline Queue refresh', () => {
  it('reports the committed reset once and closes the dialog', async () => {
    await confirmReset();
    expect(toastTitles()).toEqual(['已重置']);
    expect(reset?.dialog.open).toBe(false);
  });

  it('retains the dialog and failure when the server refuses the reset', async () => {
    mocks.apiFetch.mockImplementation(async (path: string) =>
      path.endsWith('/force-reset') ? json({ error: 'busy' }, 409) : json({ ok: true }),
    );
    await confirmReset();
    expect(toastTitles()).toEqual(['恢复未成功']);
    expect(reset?.dialog.open).toBe(true);
  });
});
