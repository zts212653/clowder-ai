import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ok, scheduleItem, scheduleProposal } from '@/components/rich/__tests__/schedule-approval.fixture';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import { apiFetch } from '@/utils/api-client';
import { createApprovalSessions } from '../approval-sessions';
import { MailboxRow } from '../MailboxRow';
import { collectiveFailure } from './collective-failure.fixture';
import { approvalRow, okRead } from './mailbox-fixtures';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
let root: ReturnType<typeof createRoot>, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useApprovalHubStore.setState({ items: [], pendingReadAvailable: false, deciding: {}, decisionAttempts: {} });
  vi.mocked(apiFetch).mockReset();
  vi.unstubAllGlobals();
});
it.each([
  false,
  true,
])('original applying schedule stays recoverable without reopening approval (Collective failure=%s)', async (outage) => {
  let proposal = scheduleProposal('applying');
  const item = scheduleItem(proposal),
    row = approvalRow(item);
  item.resolution = 'accepted';
  item.materialization = { state: 'outcome_unknown' };
  item.inlineApprovable = false;
  row.approval = { ...item };
  let generation = 1;
  const read = outage ? collectiveFailure(okRead([row]), true) : okRead([row]);
  const sessions = createApprovalSessions({
    readsStarted: () => generation,
    refetch: () => {},
    refreshStore: async () => {},
    storeItems: () => [item],
    attempts: () => ({}),
    latestRead: () => ({ result: read, generation: 1 }),
    now: Date.now,
  });
  vi.mocked(apiFetch).mockImplementation(async (path, options) => {
    if (options?.method === 'POST') {
      proposal = scheduleProposal('approved');
      return ok({ proposalId: proposal.proposalId, status: 'approved' });
    }
    return String(path) === '/api/session'
      ? ok({ userId: 'owner-1' })
      : String(path) === '/api/approval-hub/pending'
        ? ok({ items: [item] })
        : String(path).startsWith('/api/schedule-proposals/')
          ? ok({ proposal })
          : ok({ id: 'destination', title: 'Original discussion', projectPath: 'default' });
  });
  await act(async () =>
    root.render(
      <MailboxRow
        item={row}
        rowKey="recovery"
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
  expect(button?.textContent).toBe('重试执行');
  expect(button?.disabled).toBe(false);
  expect(container.querySelector('[data-testid="schedule-reject"]')).toBeNull();
  generation = 2;
  await act(async () => button?.click());
  expect(vi.mocked(apiFetch).mock.calls.some(([, o]) => o?.method === 'POST')).toBe(false);
  generation = 1;
  await act(async () => button?.click());
  expect(vi.mocked(apiFetch).mock.calls.filter(([, o]) => o?.method === 'POST')).toHaveLength(1);
  expect(vi.mocked(apiFetch).mock.calls.find(([, o]) => o?.method === 'POST')?.[0]).toBe(
    '/api/schedule-proposals/schedule-1/approve',
  );
  expect(item).toMatchObject({
    resolution: 'accepted',
    materialization: { state: 'outcome_unknown' },
    inlineApprovable: false,
  });
});

it.each([
  'pending-source',
  'terminal-source',
  'foreign-owner',
] as const)('recovery projection alone cannot authorize %s', async (failure) => {
  const item = scheduleItem(scheduleProposal('applying')),
    row = approvalRow(item);
  const proposal = scheduleProposal(
    failure === 'terminal-source' ? 'approved' : failure === 'pending-source' ? 'pending' : 'applying',
  );
  const sessions = createApprovalSessions({
    readsStarted: () => 1,
    refetch: () => {},
    refreshStore: async () => {},
    storeItems: () => [item],
    attempts: () => ({}),
    latestRead: () => ({ result: okRead([row]), generation: 1 }),
    now: Date.now,
  });
  vi.mocked(apiFetch).mockImplementation(async (path) =>
    String(path) === '/api/session'
      ? ok({ userId: failure === 'foreign-owner' ? 'foreign' : 'owner-1' })
      : String(path) === '/api/approval-hub/pending'
        ? ok({ items: [item] })
        : ok({ proposal }),
  );
  await act(async () =>
    root.render(
      <MailboxRow
        item={row}
        rowKey="recovery"
        stale={false}
        expanded={false}
        onToggle={() => {}}
        onOpen={() => {}}
        readCurrent
        hosted={{ sessions, ownerUserId: 'owner-1' }}
      />,
    ),
  );
  expect(container.querySelector('[data-testid="schedule-approve"]')).toBeNull();
  expect(vi.mocked(apiFetch).mock.calls.some(([, o]) => o?.method === 'POST')).toBe(false);
});
