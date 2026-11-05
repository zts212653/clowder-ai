import type { ApprovalDecisionReceiptV1 } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { SystemNoticeBar } from '../../SystemNoticeBar';
import { writeShellLanguage } from '../../shell/shell-language';

const mocks = vi.hoisted(() => ({ teleport: vi.fn(), close: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/teleport', () => ({ planTeleport: mocks.teleport, kickTeleportResolve: vi.fn() }));
vi.mock('@/utils/scrollToMessage', () => ({ scrollToMessage: vi.fn() }));
vi.mock('@/hooks/useCatNameResolver', () => ({ useCatNameResolver: () => () => '小太阳' }));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ getCatById: () => ({ id: 'codex61-sol', displayName: '小太阳', defaultModel: 'gpt-6.1-sol' }) }),
}));
vi.mock('@/components/CatAvatar', () => ({ CatAvatar: () => <span role="img" aria-label="小太阳头像" /> }));
vi.mock('@/stores/chatStore', () => ({
  useChatStore: { getState: () => ({ currentThreadId: 'thread_origin', closeRightPanel: mocks.close }) },
}));

let root: Root, host: HTMLDivElement;
const fact: ApprovalDecisionReceiptV1 = {
  v: 1,
  kind: 'approval_decision_receipt',
  producerId: 'F128',
  canonicalProposalId: 'proposal_receipt',
  resolution: 'accepted',
  approvalCardRef: { threadId: 'thread_origin', messageId: 'card' },
  requesterCatId: 'codex61-sol',
  decidedAt: 1793030000000,
  decidedBy: 'default-user',
};
function row(receipt: ApprovalDecisionReceiptV1) {
  return {
    proposalId: receipt.canonicalProposalId,
    sourceFeatureId: receipt.producerId,
    ownerUserId: receipt.decidedBy,
    requesterCatId: receipt.requesterCatId,
    summary: 'New thread: 来自原卡的新标题',
    detail: {},
    createdAt: 1793020000000,
    decidedAt: receipt.decidedAt,
    decidedBy: receipt.decidedBy,
    resolution: receipt.resolution,
    materialization: { state: receipt.resolution === 'accepted' ? 'outcome_unknown' : 'not_started' },
    navigation: {
      state: 'anchored',
      approvalCardRef: receipt.approvalCardRef,
      originRef: { kind: 'message', ...receipt.approvalCardRef },
    },
  };
}
function message(receipt: ApprovalDecisionReceiptV1): ChatMessage {
  return {
    id: 'receipt',
    type: 'connector',
    timestamp: receipt.decidedAt,
    content: '审批结果 proposal_receipt 不能露在界面',
    source: {
      connector: 'approval-hub',
      label: 'Host 审批结果回执',
      icon: 'info',
      meta: { approvalDecisionReceipt: receipt },
    },
  };
}
async function render(receipt = fact, adjacent = false, detail: Record<string, unknown> = {}) {
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (path === '/api/session') return Response.json({ userId: 'default-user' });
    if (String(path).includes('/approval-hub/settled')) return Response.json({ items: [{ ...row(receipt), detail }] });
    if (String(path).includes('/api/proposals/'))
      return Response.json({
        proposal: {
          proposalId: fact.canonicalProposalId,
          status: 'approved',
          createdBy: 'default-user',
          createdThreadId: 'thread_child',
        },
      });
    if (path === '/api/threads/thread_child')
      return Response.json({
        id: 'thread_child',
        createdBy: 'default-user',
        createdFromProposalId: fact.canonicalProposalId,
      });
    return Response.json({}, { status: 404 });
  });
  const shown = message(receipt);
  await act(async () =>
    root.render(
      <SystemNoticeBar
        message={shown}
        threadId="thread_origin"
        timelineMessages={adjacent ? [{ id: 'card' } as ChatMessage, shown] : [shown]}
      />,
    ),
  );
}
beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.setItem('cat-cafe-userId', 'default-user');
  writeShellLanguage('zh');
  mocks.teleport.mockReturnValue({ scrollNow: 'card' });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it('uses the original result row and canonical title, with separate source and destination actions', async () => {
  await render();
  expect(host.textContent).toContain('你同意了');
  expect(host.textContent).toContain('来自原卡的新标题');
  expect(host.textContent).toContain('对话已开');
  expect(host.textContent).not.toContain('proposal_receipt');
  expect(host.textContent).toContain('gpt-6.1-sol');
  expect(host.textContent).toContain('新对话「');
  expect(
    host.querySelector(
      '[data-testid="thread-proposal-result"] [data-testid="decision-result-row"][data-presentation="chat-receipt"]',
    ),
  ).not.toBeNull();
  expect(host.querySelector('a[href]')).toBeNull();
  const source = host.querySelector<HTMLButtonElement>('button[title="回原提议"]');
  await act(async () => source?.click());
  expect(mocks.teleport).toHaveBeenCalledWith({
    threadId: 'thread_origin',
    messageId: 'card',
    currentThreadId: 'thread_origin',
  });
  expect(mocks.close).toHaveBeenCalledOnce();
});

it('hides only the adjacent receipt while preserving its message anchor and stored body', async () => {
  await render(fact, true);
  expect(host.querySelector('[data-testid="chat-approval-receipt"]')).toBeNull();
  expect(host.querySelector('[data-message-id="receipt"]')?.getAttribute('aria-hidden')).toBe('true');
  expect(message(fact).content).toContain('proposal_receipt');
  expect(apiFetch).not.toHaveBeenCalled();
});

it('shows a real rejection reason and red decision without inventing an opened conversation', async () => {
  await render({ ...fact, resolution: 'rejected', rejectionReason: '先把原任务做完 <不是标签>' });
  expect(host.textContent).toContain('你拒绝了');
  expect(host.textContent).toContain('理由：先把原任务做完 <不是标签>');
  expect(host.querySelector('[data-status="rejected"]')).not.toBeNull();
  expect(host.textContent).not.toContain('对话已开');
  expect(host.querySelector('[data-testid="proposal-result-open"]')).toBeNull();
});

it('uses the original runtime selection result without mounting another responder', async () => {
  await render({ ...fact, producerId: 'F306' }, false, {
    runtimeKind: 'question',
    runtimeSelectedLabels: ['先完成原任务'],
    runtimeReason: 'answered',
  });
  expect(host.textContent).toContain('你处理了');
  expect(host.textContent).toContain('先完成原任务');
  expect(host.querySelector('[data-presentation="chat-receipt"]')).not.toBeNull();
  expect(host.querySelector('form, input, [role="radio"], [role="checkbox"]')).toBeNull();
  expect(vi.mocked(apiFetch).mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
});
