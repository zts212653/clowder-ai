import type { ApprovalDecisionReceiptV1 } from '@cat-cafe/shared';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { readChatApprovalReceipt, receiptImmediatelyFollowsCard } from '../receipt-source';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
const receipt: ApprovalDecisionReceiptV1 = {
  v: 1,
  kind: 'approval_decision_receipt',
  producerId: 'F128',
  canonicalProposalId: 'proposal_receipt',
  resolution: 'accepted',
  approvalCardRef: { threadId: 'thread_origin', messageId: 'card' },
  requesterCatId: 'codex61-sol',
  decidedAt: 1793030000000,
  decidedBy: 'owner',
};
const item = {
  sourceFeatureId: 'F128',
  proposalId: receipt.canonicalProposalId,
  ownerUserId: 'owner',
  requesterCatId: 'codex61-sol',
  summary: 'New thread: 来自原提议的标题',
  detail: { title: '来自原提议的标题' },
  createdAt: 1793020000000,
  decidedAt: receipt.decidedAt,
  decidedBy: 'owner',
  resolution: 'accepted',
  materialization: { state: 'outcome_unknown' },
  navigation: {
    state: 'anchored',
    approvalCardRef: receipt.approvalCardRef,
    originRef: { kind: 'message', ...receipt.approvalCardRef },
  },
};
let row: typeof item, owner: string, threadAvailable: boolean;
beforeEach(() => {
  row = structuredClone(item);
  owner = 'owner';
  threadAvailable = true;
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (path === '/api/session') return Response.json({ userId: owner });
    if (String(path).includes('/approval-hub/settled')) return Response.json({ items: [row] });
    if (String(path).includes('/api/proposals/'))
      return Response.json({
        proposal: {
          proposalId: receipt.canonicalProposalId,
          status: 'approved',
          createdBy: 'owner',
          createdThreadId: 'thread_child',
        },
      });
    if (path === '/api/threads/thread_child')
      return threadAvailable
        ? Response.json({ id: 'thread_child', createdBy: 'owner', createdFromProposalId: receipt.canonicalProposalId })
        : Response.json({}, { status: 403 });
    return Response.json({}, { status: 404 });
  });
});

it('reads the canonical title and exact producer effect in one bounded history window', async () => {
  const source = await readChatApprovalReceipt(receipt, new AbortController().signal);
  expect(source?.item.summary).toBe(item.summary);
  expect(source?.terminal.threadId).toBe('thread_child');
  expect(vi.mocked(apiFetch).mock.calls.filter(([path]) => String(path).includes('/settled'))).toHaveLength(1);
  expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path === '/api/approval-hub/settled?limit=200')).toBe(true);
  expect(vi.mocked(apiFetch).mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
});

it.each([
  'requesterCatId',
  'decidedBy',
  'decidedAt',
  'resolution',
] as const)('rejects a different canonical %s', async (field) => {
  Object.assign(row, { [field]: field === 'decidedAt' ? 12 : 'other' });
  expect(await readChatApprovalReceipt(receipt, new AbortController().signal)).toBeNull();
});

it('rejects a relocated original card and an unreadable source instead of inferring success', async () => {
  row.navigation.approvalCardRef.messageId = 'other-card';
  expect(await readChatApprovalReceipt(receipt, new AbortController().signal)).toBeNull();
  vi.mocked(apiFetch).mockResolvedValue(Response.json({}, { status: 503 }));
  expect(await readChatApprovalReceipt(receipt, new AbortController().signal)).toBeNull();
});

it('keeps a missing or forbidden child effect unknown', async () => {
  threadAvailable = false;
  const source = await readChatApprovalReceipt(receipt, new AbortController().signal);
  expect(source?.terminal.effectUnknown).toBe(true);
  expect(source?.terminal.threadId).toBeUndefined();
});

it('does not install an old owner response after identity changes', async () => {
  const original = vi.mocked(apiFetch).getMockImplementation();
  vi.mocked(apiFetch).mockImplementation(async (path, init, options) => {
    const response = await original?.(path, init, options);
    if (path === '/api/threads/thread_child') owner = 'new-owner';
    return response ?? Response.json({}, { status: 404 });
  });
  expect(await readChatApprovalReceipt(receipt, new AbortController().signal)).toBeNull();
});

it('suppresses only immediate adjacency in the same supplied timeline', () => {
  const messages = [{ id: 'card' }, { id: 'receipt' }] as ChatMessage[];
  expect(receiptImmediatelyFollowsCard('receipt', receipt, 'thread_origin', messages)).toBe(true);
  expect(receiptImmediatelyFollowsCard('receipt', receipt, 'other-thread', messages)).toBe(false);
  expect(
    receiptImmediatelyFollowsCard('receipt', receipt, 'thread_origin', [
      { id: 'card' },
      { id: 'other' },
      { id: 'receipt' },
    ] as ChatMessage[]),
  ).toBe(false);
  expect(receiptImmediatelyFollowsCard('receipt', receipt, 'thread_origin', [{ id: 'receipt' }] as ChatMessage[])).toBe(
    false,
  );
});
