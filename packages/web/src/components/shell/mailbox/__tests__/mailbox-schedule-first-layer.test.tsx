import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { coordinate, ok, scheduleItem, scheduleProposal } from '@/components/rich/__tests__/schedule-approval.fixture';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import { apiFetch } from '@/utils/api-client';
import { createApprovalSessions } from '../approval-sessions';
import { MailboxRow } from '../MailboxRow';
import { approvalRow, okRead } from './mailbox-fixtures';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
it('a collapsed scheduled task uses its original card and current-read guard, without generic explanation', async () => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const item = scheduleItem(),
    row = approvalRow(item);
  let generation = 1;
  vi.mocked(apiFetch).mockImplementation(async (path) =>
    String(path) === '/api/session'
      ? ok({ userId: 'owner-1' })
      : String(path) === '/api/approval-hub/pending'
        ? ok({ items: [item], count: 1 })
        : String(path) === '/api/schedule-proposals/schedule-1'
          ? ok({ proposal: scheduleProposal() })
          : ok({ id: 'destination', title: 'Original discussion', projectPath: 'default' }),
  );
  await useApprovalHubStore.getState().fetchPending();
  const sessions = createApprovalSessions({
    readsStarted: () => generation,
    refetch: () => {},
    refreshStore: () => useApprovalHubStore.getState().fetchPending(),
    storeItems: () => useApprovalHubStore.getState().items,
    attempts: () => ({}),
    latestRead: () => ({ result: okRead([row]), generation: 1 }),
    now: Date.now,
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <MailboxRow
          item={row}
          rowKey="scheduled-task"
          stale={false}
          expanded={false}
          onToggle={() => {}}
          onOpen={() => {}}
          readCurrent
          hosted={{ sessions, ownerUserId: 'owner-1' }}
        />,
      ),
    );
    const button = container.querySelector<HTMLButtonElement>('[data-testid="schedule-approve"]');
    expect(button).not.toBeNull();
    expect(button?.disabled).toBe(false);
    expect(container.querySelector('[data-testid="mailbox-item-toggle"]')).toBeNull();
    expect(container.textContent).toContain('Read the evidence');
    expect(container.textContent).not.toContain('提议者 / 为什么');
    expect(container.querySelector('details')?.open).toBe(false);
    generation = 2;
    await act(async () => button?.click());
    expect(vi.mocked(apiFetch).mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
    expect(item.navigation.state === 'anchored' ? item.navigation.approvalCardRef : null).toEqual(coordinate);
  } finally {
    act(() => root.unmount());
    container.remove();
    useApprovalHubStore.setState({ items: [], pendingReadAvailable: false, deciding: {}, decisionAttempts: {} });
    vi.mocked(apiFetch).mockReset();
    vi.unstubAllGlobals();
  }
});
