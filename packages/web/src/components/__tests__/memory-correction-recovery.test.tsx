import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { approvalRow, okRead } from '@/components/shell/mailbox/__tests__/mailbox-fixtures';
import { createApprovalSessions } from '@/components/shell/mailbox/approval-sessions';
import { MailboxRow } from '@/components/shell/mailbox/MailboxRow';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import { apiFetch } from '@/utils/api-client';
import { RichBlocks } from '../rich/RichBlocks';
import { createCorrectionItem, installCorrectionApi } from './memory-correction-approval.fixture';

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
  useApprovalHubStore.setState({
    items: [],
    pendingReadAvailable: false,
    isLoading: false,
    deciding: {},
    decisionAttempts: {},
  });
  vi.mocked(apiFetch).mockReset();
  vi.unstubAllGlobals();
});
it.each([
  'Chat',
  'Inbox',
] as const)('resumes the original approving correction in %s without re-opening its approval', async (entrance) => {
  const item = {
    ...createCorrectionItem(),
    resolution: 'accepted' as const,
    materialization: { state: 'outcome_unknown' as const },
    inlineApprovable: false,
  };
  let generation = 1;
  let terminal = false;
  installCorrectionApi(
    () => ({ pending: !terminal, owner: 'owner-1', changed: false, terminal, approveOnPost: true, approving: true }),
    () => item,
    () => {
      terminal = true;
    },
  );
  const row = approvalRow(item);
  const sessions = createApprovalSessions({
    readsStarted: () => generation,
    refetch: () => {},
    refreshStore: async () => {},
    storeItems: () => [item],
    attempts: () => ({}),
    latestRead: () => ({ result: okRead([row]), generation: 1 }),
    now: Date.now,
  });
  await act(async () =>
    root.render(
      entrance === 'Inbox' ? (
        <MailboxRow
          item={row}
          rowKey="recovery"
          stale={false}
          expanded={false}
          onToggle={() => {}}
          onOpen={() => {}}
          hosted={{ sessions, ownerUserId: 'owner-1' }}
          readCurrent
        />
      ) : (
        <RichBlocks
          publication={{ threadId: 'thread-a', messageId: 'card-a', messageRevision: 'v1' }}
          blocks={[
            {
              kind: 'card',
              v: 1,
              id: 'event-memory-correction-correction-a',
              title: '原卡',
              meta: { approval: { producerId: 'F321', canonicalProposalId: 'correction-a' } },
            },
          ]}
        />
      ),
    ),
  );
  const resume = [...container.querySelectorAll('button')].find((b) => b.textContent === '重试这次接受');
  expect(resume?.disabled).toBe(false);
  expect(container.textContent).not.toContain('拒绝这条建议');
  if (entrance === 'Inbox') {
    generation = 2;
    await act(async () => resume?.click());
    expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
    generation = 1;
  }
  await act(async () => resume?.click());
  const posts = vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(posts).toHaveLength(1);
  expect(posts[0]?.[0]).toBe('/api/event-memory-corrections/correction-a/approve');
  expect(posts[0]?.[1]?.body).toBe('{}');
  expect(item).toMatchObject({
    resolution: 'accepted',
    materialization: { state: 'outcome_unknown' },
    inlineApprovable: false,
  });
});

it.each([
  'foreign-owner',
  'pending-source',
  'inline-enabled',
  'source-absent',
] as const)('accepted recovery cannot authorize %s', async (failure) => {
  const item = {
    ...createCorrectionItem(),
    resolution: 'accepted' as const,
    materialization: { state: 'outcome_unknown' as const },
    inlineApprovable: failure === 'inline-enabled',
  };
  installCorrectionApi(
    () => ({
      pending: failure !== 'source-absent',
      owner: failure === 'foreign-owner' ? 'foreign' : 'owner-1',
      changed: false,
      terminal: false,
      approveOnPost: false,
      approving: failure !== 'pending-source',
    }),
    () => item,
    () => {},
  );
  await act(async () =>
    root.render(
      <RichBlocks
        publication={{ threadId: 'thread-a', messageId: 'card-a', messageRevision: 'v1' }}
        blocks={[
          {
            kind: 'card',
            v: 1,
            id: 'event-memory-correction-correction-a',
            title: '原卡',
            meta: { approval: { producerId: 'F321', canonicalProposalId: 'correction-a' } },
          },
        ]}
      />,
    ),
  );
  for (const button of [...container.querySelectorAll('button')]) {
    if (button.textContent === '重试这次接受' || button.textContent === '接受这条建议')
      await act(async () => button.click());
  }
  expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toEqual([]);
});
