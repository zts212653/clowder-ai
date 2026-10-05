/**
 * `useQueueActionConvergence` is shared with the classic queue panel. The new shell's row needs one improvement the
 * classic panel must not get (the classic interface is frozen): a force-reset that went through is reported as done even
 * when the re-read after it throws. It is an opt-in option, off by default. These two cases pin both sides.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useToastStore } from '@/stores/toastStore';
import { type QueueActionConvergenceOptions, useQueueActionConvergence } from '../../useQueueActionConvergence';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: mocks.apiFetch }));

const THREAD = 'thread-t';
const ACTION = {
  id: 'queue-force-reset:q1:1',
  entryId: 'q1',
  kind: 'force_reset' as const,
  request: { method: 'POST' as const, path: `/api/threads/${THREAD}/force-reset` },
};

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

let convergence: ReturnType<typeof useQueueActionConvergence> | null = null;
function Harness({ options }: { options?: QueueActionConvergenceOptions }) {
  convergence = useQueueActionConvergence(THREAD, options);
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
  convergence = null;
});

const toastTitles = () => useToastStore.getState().toasts.map((toast) => toast.title);

async function confirmReset(options?: QueueActionConvergenceOptions) {
  await act(async () => root.render(<Harness options={options} />));
  await act(async () => convergence?.handleForceResetOpen(ACTION));
  await act(async () => {
    await convergence?.handleForceResetConfirm();
  });
}

describe('useQueueActionConvergence: force-reset when the re-read after a successful reset throws', () => {
  it('default (the classic panel): unchanged — reported as not done and left open', async () => {
    await confirmReset();
    expect(toastTitles()).toEqual(['恢复未成功']);
    expect(convergence?.forceResetAction).not.toBeNull();
  });

  it('resetDoneSurvivesRereadFailure (the new row): the reset that went through is done and the dialog closes', async () => {
    await confirmReset({ resetDoneSurvivesRereadFailure: true });
    expect(toastTitles()).toEqual(['已恢复']);
    expect(convergence?.forceResetAction).toBeNull();
  });

  it('negative control: a reset the server refuses is not done under either setting', async () => {
    mocks.apiFetch.mockImplementation(async (path: string) =>
      path.endsWith('/force-reset') ? json({ error: 'busy' }, 409) : json({ ok: true }),
    );
    await confirmReset({ resetDoneSurvivesRereadFailure: true });
    expect(toastTitles()).toEqual(['恢复未成功']);
    expect(convergence?.forceResetAction).not.toBeNull();
  });
});
