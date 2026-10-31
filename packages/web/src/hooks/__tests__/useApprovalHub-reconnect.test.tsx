import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

const { fetchPending } = vi.hoisted(() => ({ fetchPending: vi.fn() }));
vi.mock('@/stores/approvalHubStore', () => ({
  useApprovalHubStore: (select: (s: { fetchPending: typeof fetchPending }) => unknown) => select({ fetchPending }),
}));

import { useApprovalHubSync } from '../useApprovalHub';

function Harness() {
  useApprovalHubSync();
  return null;
}
it('re-reads the canonical approval owner on reconnect and stops observing after unmount', () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    act(() => root.render(<Harness />));
    expect(fetchPending).toHaveBeenCalledTimes(1);
    act(() => window.dispatchEvent(new Event('cat-cafe:socket-reconnected')));
    expect(fetchPending).toHaveBeenCalledTimes(2);
    act(() => root.unmount());
    window.dispatchEvent(new Event('cat-cafe:socket-reconnected'));
    expect(fetchPending).toHaveBeenCalledTimes(2);
  } finally {
    container.remove();
  }
});
