import type { ApprovalHubItem, RichCardBlock } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { approvalRow, okRead, storeItem } from '@/components/shell/mailbox/__tests__/mailbox-fixtures';
import { createApprovalSessions } from '@/components/shell/mailbox/approval-sessions';
import { MailboxRow } from '@/components/shell/mailbox/MailboxRow';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import { apiFetch } from '@/utils/api-client';
import { RichBlocks } from '../RichBlocks';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
let container: HTMLDivElement, root: Root, item: ApprovalHubItem, block: RichCardBlock, proofAvailable: boolean;
let settled: Record<string, unknown>[];
let completeOnPost: boolean;
let mismatchedReceipt: boolean;
let tasteStatus: 'pending' | 'approving';
const publication = { threadId: 'thread-src', messageId: 'card-msg', messageRevision: 'v1' };
beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  proofAvailable = true;
  settled = [];
  completeOnPost = false;
  mismatchedReceipt = false;
  tasteStatus = 'pending';
  vi.mocked(apiFetch).mockImplementation(async (path, options) => {
    if (completeOnPost && options?.method === 'POST') {
      proofAvailable = false;
      settled = [{ ...item, resolution: 'accepted', decidedAt: Date.now(), decidedBy: 'owner-1' }];
      return Response.json(
        item.sourceFeatureId === 'F193'
          ? {
              proposal: {
                proposalId: mismatchedReceipt ? 'another-proposal' : item.proposalId,
                ownerUserId: item.ownerUserId,
                status: 'approved',
                targetThreadId: item.detail.targetThreadId,
                deliveredMessageId: 'private-delivery',
              },
            }
          : {
              proposalId: mismatchedReceipt ? 'another-proposal' : item.proposalId,
              status: 'approved',
              entityId: item.detail.entityId,
              vignettePath: 'private-vignette',
            },
      );
    }
    const row = {
      ...approvalRow(item),
      ...(proofAvailable
        ? {
            originalApprovalCard: {
              cardRef: { threadId: publication.threadId, messageId: publication.messageId, blockId: block.id },
              block,
            },
          }
        : {}),
    };
    const state = okRead([row]);
    return {
      ok: true,
      status: 200,
      json: async () =>
        String(path) === '/api/session'
          ? { userId: 'owner-1' }
          : String(path).includes('/approval-hub/settled')
            ? { items: settled }
            : String(path).includes('/approval-hub/pending')
              ? { items: [item], count: 1 }
              : String(path).includes('/concierge/')
                ? state.kind === 'ok'
                  ? state.read
                  : null
                : String(path).includes('/taste-proposals/')
                  ? { proposalId: item.proposalId, status: tasteStatus }
                  : { title: 'Original conversation' },
    } as Response;
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.mocked(apiFetch).mockReset();
  vi.unstubAllGlobals();
  useApprovalHubStore.setState({
    items: [],
    pendingReadAvailable: false,
    isLoading: false,
    deciding: {},
    decisionAttempts: {},
  });
});
function seed(feature: 'F193' | 'F221' | 'F260') {
  item = storeItem({
    sourceFeatureId: feature,
    createdAt: Date.now(),
    navigation: {
      state: 'anchored',
      originRef: { kind: 'message', threadId: 'thread-src', messageId: 'origin' },
      approvalCardRef: { threadId: 'thread-src', messageId: 'card-msg' },
    },
    detail: {
      content: 'Original request',
      targetThreadId: 'target',
      targetCats: ['codex61-sol'],
      scene: 'Original scene',
      quote: 'Original quote',
      dimension: 'cognitive-honesty',
      privacy: 'public',
      tags: [],
      entityType: 'concept',
      entityId: 'concept:original',
      canonicalName: 'Original entity',
      stance: 'endorsed',
      aliases: [],
    },
  });
  block = {
    id: `${feature === 'F193' ? 'dispatch' : feature === 'F221' ? 'taste-proposal' : 'entity-proposal'}-${item.proposalId}`,
    kind: 'card',
    v: 1,
    title: 'Original proposal',
    bodyMarkdown: 'Original request',
    meta: { approval: { producerId: feature, canonicalProposalId: item.proposalId } },
  };
}
it.each(['Chat', 'Inbox'] as const)('uses the existing taste recovery on its original %s host', async (entrance) => {
  seed('F221');
  tasteStatus = 'approving';
  item = { ...item, resolution: 'accepted', materialization: { state: 'outcome_unknown' }, inlineApprovable: false };
  const row = {
    ...approvalRow(item),
    originalApprovalCard: {
      cardRef: { threadId: publication.threadId, messageId: publication.messageId, blockId: block.id },
      block,
    },
  };
  const sessions = createApprovalSessions({
    readsStarted: () => 1,
    refetch: () => {},
    refreshStore: async () => {},
    storeItems: () => [item],
    attempts: () => ({}),
    latestRead: () => ({ result: okRead([row]), generation: 1 }),
    now: Date.now,
  });
  await act(async () =>
    root.render(
      entrance === 'Chat' ? (
        <RichBlocks blocks={[block]} publication={publication} />
      ) : (
        <MailboxRow
          item={row}
          rowKey="taste-recovery"
          stale={false}
          expanded={false}
          onToggle={() => {}}
          onOpen={() => {}}
          hosted={{ sessions, ownerUserId: 'owner-1' }}
          readCurrent
          personal={{ mode: 'visible', refusal: () => null, change: async () => true }}
        />
      ),
    ),
  );
  const resume = container.querySelector<HTMLButtonElement>('[data-testid="approve-btn"]');
  expect(resume?.textContent).toBe('继续写入');
  expect(resume?.disabled).toBe(false);
  if (entrance === 'Inbox') {
    expect(container.querySelectorAll('[data-testid="mailbox-item-ignore"]')).toHaveLength(1);
    expect(
      container.querySelector('[data-testid="domain-approval-place-actions"] [data-testid="mailbox-item-ignore"]'),
    ).not.toBeNull();
  }
  expect(container.querySelector('[data-testid="reject-btn"]')).toBeNull();
  await act(async () => resume?.click());
  const posts = vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(posts).toHaveLength(1);
  expect(posts[0]?.[0]).toBe('/api/taste-proposals/p-1/approve');
  expect(item.resolution).toBe('accepted');
  expect(item.inlineApprovable).toBe(false);
});
it.each(['F193', 'F221', 'F260'] as const)('hosts the original %s writer on its actual Chat card', async (feature) => {
  seed(feature);
  await act(async () => root.render(<RichBlocks blocks={[block]} publication={publication} />));
  const button = container.querySelector<HTMLButtonElement>('[data-testid="approve-btn"]');
  expect(button?.disabled).toBe(false);
  await act(async () => button?.click());
  const base = feature === 'F193' ? 'dispatch' : feature === 'F221' ? 'taste' : 'entity';
  expect(
    vi
      .mocked(apiFetch)
      .mock.calls.some(
        ([path, options]) => path === `/api/${base}-proposals/${item.proposalId}/approve` && options?.method === 'POST',
      ),
  ).toBe(true);
});
it('withdraws Chat authority when the original proof is gone and leaves the read state unknown', async () => {
  seed('F193');
  await act(async () => root.render(<RichBlocks blocks={[block]} publication={publication} />));
  const button = container.querySelector<HTMLButtonElement>('[data-testid="approve-btn"]');
  expect(button).not.toBeNull();
  proofAvailable = false;
  await act(async () => button?.click());
  expect(vi.mocked(apiFetch).mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  expect(container.querySelector<HTMLButtonElement>('[data-testid="approve-btn"]')?.disabled).toBe(true);
});
it('keeps injected information-card actions out of every generic writer fallback', async () => {
  seed('F193');
  block = {
    ...block,
    actions: [
      { label: 'Unexpected action', action: 'profile-update:approve', payload: { proposalId: 'another-proposal' } },
    ],
  };
  await act(async () => root.render(<RichBlocks blocks={[block]} publication={publication} />));
  expect(container.textContent).not.toContain('Unexpected action');
  expect(container.querySelector('[data-testid="approve-btn"]')).toBeNull();
  expect(vi.mocked(apiFetch).mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
});
it.each([
  'F193',
  'F221',
  'F260',
] as const)('cold-reads the exact %s decision on its original Chat card', async (feature) => {
  seed(feature);
  proofAvailable = false;
  settled = [{ ...item, resolution: 'rejected', decidedAt: Date.now(), decidedBy: 'owner-1' }];
  await act(async () => root.render(<RichBlocks blocks={[block]} publication={publication} />));
  expect(container.querySelector('[data-testid="domain-approval-result"]')?.textContent).toContain('已拒绝');
  expect(container.querySelector('[data-testid="domain-approval-result"]')?.textContent).toContain('你');
  expect(container.querySelector('[data-testid="domain-approval-unverified"]')).toBeNull();
  expect(container.querySelector('[data-testid="approve-btn"]')).toBeNull();
  expect(vi.mocked(apiFetch).mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
});
it('does not borrow a settled result from another publication or owner', async () => {
  seed('F193');
  proofAvailable = false;
  settled = [
    {
      ...item,
      resolution: 'accepted',
      ownerUserId: 'foreign',
      navigation: {
        ...item.navigation,
        approvalCardRef: { threadId: 'thread-src', messageId: 'different-card' },
      },
    },
  ];
  await act(async () => root.render(<RichBlocks blocks={[block]} publication={publication} />));
  expect(container.querySelector('[data-testid="domain-approval-result"]')).toBeNull();
  expect(container.querySelector('[data-testid="domain-approval-unverified"]')).not.toBeNull();
});
it.each([
  ['F193', '原消息已送达'],
  ['F221', '品味已写入'],
  ['F260', '实体已写入'],
] as const)('retains the %s original response effect only after a subsequent exact terminal read', async (feature, label) => {
  seed(feature);
  completeOnPost = true;
  await act(async () => root.render(<RichBlocks blocks={[block]} publication={publication} />));
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="approve-btn"]')?.click());
  const result = container.querySelector('[data-testid="domain-approval-result"]');
  expect(result?.textContent).toContain(label);
  expect(result?.textContent).not.toContain('private-');
  expect(container.querySelector('[data-testid="approve-btn"]')).toBeNull();
});
it.each([
  'F193',
  'F221',
  'F260',
] as const)('keeps a %s receipt for another proposal out of the proven result', async (feature) => {
  seed(feature);
  completeOnPost = true;
  mismatchedReceipt = true;
  await act(async () => root.render(<RichBlocks blocks={[block]} publication={publication} />));
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="approve-btn"]')?.click());
  expect(container.querySelector('[data-testid="domain-approval-result"]')?.textContent).toContain('效果暂未确认');
});
