import type { ApprovalDecisionReceiptV1 } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProposalCardChat } from '@/components/rich/ProposalCardChat';
import { retainSettledResult } from '@/components/shell/mailbox/approval-history-page-source';
import { HandledApprovalRow } from '@/components/shell/mailbox/HandledApprovalRow';
import type { SettledResultItem } from '@/components/shell/mailbox/settled-results-source';
import type { ChatMessage } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { observeApiSessionOwner } from '@/utils/api-session-identity';
import { ChatApprovalDecisionReceipt } from '../ChatApprovalDecisionReceipt';
import { readChatApprovalReceipt } from '../receipt-source';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/userId', () => ({ getUserId: () => 'owner' }));
vi.mock('@/hooks/useCatNameResolver', () => ({ useCatNameResolver: () => () => 'Sol' }));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ getCatById: () => ({ id: 'codex61-sol', displayName: 'Sol', defaultModel: 'gpt-6.1-sol' }) }),
}));
vi.mock('@/components/CatAvatar', () => ({ CatAvatar: () => <span>avatar</span> }));
vi.mock('@/components/rich/ProposalCardProducer', () => ({
  ProposalCardProducer: ({ proposal }: { proposal: { status: string } }) => <span>{proposal.status}</span>,
}));
const receipt: ApprovalDecisionReceiptV1 = {
  v: 1,
  kind: 'approval_decision_receipt',
  producerId: 'F128',
  canonicalProposalId: 'shared',
  requesterCatId: 'codex61-sol',
  decidedBy: 'owner',
  decidedAt: 1000,
  resolution: 'accepted',
  approvalCardRef: { threadId: 'parent', messageId: 'card' },
};
const initial: SettledResultItem = {
  proposalId: 'shared',
  sourceFeatureId: 'F128',
  ownerUserId: 'owner',
  requesterCatId: 'codex61-sol',
  summary: 'New thread: Shared result',
  detail: { title: 'Shared result' },
  createdAt: 1,
  decidedAt: 1000,
  decidedBy: 'owner',
  resolution: 'accepted',
  materialization: { state: 'outcome_unknown' },
  navigation: {
    state: 'anchored',
    approvalCardRef: receipt.approvalCardRef,
    originRef: { kind: 'message', ...receipt.approvalCardRef },
  },
};
const complete: SettledResultItem = {
  ...initial,
  detail: {
    ...initial.detail,
    createdThreadId: 'child',
    canonicalEffectProofRef: 'thread:child',
    createdThreadProof: { threadId: 'child', ownerUserId: 'owner', proposalId: 'shared' },
  },
  materialization: { state: 'succeeded', effectProofRef: 'thread:child' },
};
const message: ChatMessage = {
  id: 'receipt',
  type: 'connector',
  timestamp: 1000,
  content: 'machine receipt',
  source: { connector: 'approval-hub', label: 'Receipt', icon: 'info', meta: { approvalDecisionReceipt: receipt } },
};
const block = {
  kind: 'card' as const,
  v: 1 as const,
  id: 'proposal:shared',
  title: 'Original card',
  actions: [{ label: 'Approve', action: 'propose:approve', payload: { proposalId: 'shared' } }],
};
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  observeApiSessionOwner('owner');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (path === '/api/session') return Response.json({ userId: 'owner' });
    if (String(path).includes('/settled')) return Response.json({ items: [initial] });
    if (String(path).includes('/api/proposals/'))
      return Response.json({
        proposal: {
          proposalId: 'shared',
          status: 'approved',
          createdBy: 'owner',
          createdAt: 1,
          sourceCatId: 'codex61-sol',
          sourceThreadId: 'parent',
          cardMessageId: 'card',
          title: 'Shared result',
          reason: 'Actual reason',
          parentThreadId: 'parent',
          preferredCats: ['codex61-sol'],
          projectPath: '/isolated',
        },
      });
    return Response.json({}, { status: 404 });
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.mocked(apiFetch).mockReset();
  vi.unstubAllGlobals();
});
const render = () => (
  <>
    <div data-testid="original">
      <ProposalCardChat block={block} messageId="card" />
    </div>
    <div data-testid="receipt-consumer">
      <ChatApprovalDecisionReceipt message={message} threadId="parent" timelineMessages={[message]} />
    </div>
    <ul data-testid="handled">
      <HandledApprovalRow item={initial} reread={() => {}} authorizeOpen={() => true} onOpenPlace={() => {}} />
    </ul>
  </>
);
it('mounted original card, receipt, and handled row consume one updated result; confirmed remounts issue no GET', async () => {
  retainSettledResult(initial);
  await act(async () => root.render(render()));
  const first = await readChatApprovalReceipt(receipt, new AbortController().signal);
  expect(first?.terminal.effectUnknown).toBe(true);
  const before = vi.mocked(apiFetch).mock.calls.length;
  await act(async () => {
    retainSettledResult(complete);
  });
  for (const id of ['original', 'receipt-consumer', 'handled'])
    expect(host.querySelector(`[data-testid="${id}"]`)?.textContent).toContain('对话已开');
  expect(vi.mocked(apiFetch).mock.calls.length).toBe(before);
  await act(async () => root.render(null));
  await act(async () => root.render(render()));
  for (const id of ['original', 'receipt-consumer', 'handled'])
    expect(host.querySelector(`[data-testid="${id}"]`)?.textContent).toContain('对话已开');
  expect(vi.mocked(apiFetch).mock.calls.length).toBe(before);
});
it('a previous unavailable receipt recovers from a valid history proof without HTTP', async () => {
  vi.mocked(apiFetch).mockImplementation(async (path) =>
    path === '/api/session' ? Response.json({ userId: 'owner' }) : Response.json({}, { status: 503 }),
  );
  expect(await readChatApprovalReceipt(receipt, new AbortController().signal)).toBeNull();
  vi.mocked(apiFetch).mockClear();
  retainSettledResult(complete);
  expect((await readChatApprovalReceipt(receipt, new AbortController().signal))?.terminal.threadId).toBe('child');
  expect(apiFetch).not.toHaveBeenCalled();
});
