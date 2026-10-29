import type { ApprovalHubItem, UnifiedAttentionItemV1 } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import { apiFetch } from '@/utils/api-client';
import { createApprovalSessions } from '../approval-sessions';
import { MailboxRow } from '../MailboxRow';
import { collectiveFailure } from './collective-failure.fixture';
import { approvalRow, okRead, storeItem } from './mailbox-fixtures';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
let root: Root, container: HTMLDivElement, item: ApprovalHubItem, generation: number;
let row: UnifiedAttentionItemV1;
beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  generation = 1;
  vi.mocked(apiFetch).mockImplementation(
    async (path) =>
      ({
        ok: true,
        status: 200,
        json: async () =>
          String(path).includes('/approval-hub/pending')
            ? { items: [item], count: 1 }
            : String(path) === '/api/session'
              ? { userId: 'owner-1' }
              : String(path).includes('/concierge/')
                ? (okRead([row]) as { kind: 'ok'; read: unknown }).read
                : String(path).includes('/taste-proposals/')
                  ? { proposalId: item.proposalId, status: 'pending' }
                  : { id: 'target', title: 'Original discussion', projectPath: 'default' },
      }) as Response,
  );
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useApprovalHubStore.setState({ items: [], pendingReadAvailable: false, deciding: {}, decisionAttempts: {} });
  vi.mocked(apiFetch).mockReset();
  vi.unstubAllGlobals();
});
it.each(
  (['F193', 'F221', 'F260'] as const).flatMap((feature) => [false, true].map((outage) => ({ feature, outage }))),
)('puts original $feature on the first layer (Collective failure=$outage) and retains the current-read barrier', async ({
  feature,
  outage,
}) => {
  item = storeItem({
    sourceFeatureId: feature,
    detail: {
      targetThreadId: 'target',
      targetCats: ['codex61-sol'],
      content: 'Original work request',
      takeaway: 'Original taste conclusion',
      scene: 'Original scene',
      quote: 'Original quote',
      dimension: 'cognitive-honesty',
      tags: ['evidence'],
      privacy: 'public',
      canonicalName: 'Original entity',
      aliases: ['Original alias'],
      entityType: 'concept',
      stance: 'endorsed',
      rationale: 'Original rationale',
    },
  });
  row = approvalRow(item);
  if (item.navigation.state !== 'anchored') throw new Error('Expected canonical fixture');
  const ref = item.navigation.approvalCardRef,
    prefix = feature === 'F193' ? 'dispatch' : feature === 'F221' ? 'taste-proposal' : 'entity-proposal';
  const block = {
    id: `${prefix}-${item.proposalId}`,
    kind: 'card' as const,
    v: 1 as const,
    title: 'Original proposal',
    meta: { approval: { producerId: feature, canonicalProposalId: item.proposalId } },
  };
  row.originalApprovalCard = { cardRef: { ...ref, blockId: block.id }, block };
  const sessions = createApprovalSessions({
    readsStarted: () => generation,
    refetch: () => {},
    refreshStore: () => useApprovalHubStore.getState().fetchPending(),
    storeItems: () => useApprovalHubStore.getState().items,
    attempts: () => useApprovalHubStore.getState().decisionAttempts,
    latestRead: () => ({ result: outage ? collectiveFailure(okRead([row]), true) : okRead([row]), generation: 1 }),
    now: Date.now,
  });
  await act(async () =>
    root.render(
      <MailboxRow
        item={row}
        rowKey="original-domain"
        stale={false}
        expanded={false}
        onToggle={() => {}}
        onOpen={() => {}}
        readCurrent
        hosted={{ sessions, ownerUserId: 'owner-1' }}
      />,
    ),
  );
  const button = container.querySelector<HTMLButtonElement>('[data-testid="approve-btn"]');
  expect(button).not.toBeNull();
  expect(button?.disabled).toBe(false);
  expect(container.querySelector('details')?.open).toBe(false);
  generation = 2;
  await act(async () => button?.click());
  expect(vi.mocked(apiFetch).mock.calls.some(([, o]) => o?.method === 'POST')).toBe(false);
  generation = 1;
  const unsubscribe = useApprovalHubStore.subscribe(() => sessions.attemptsChanged());
  try {
    await act(async () => button?.click());
    expect(sessions.list()[0]?.model.state.kind).toBe('confirming');
  } finally {
    unsubscribe();
  }
});
