import type { ApprovalHubItem, RichCardBlock } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { approvalRow, okRead } from '@/components/shell/mailbox/__tests__/mailbox-fixtures';
import { createApprovalSessions } from '@/components/shell/mailbox/approval-sessions';
import { MailboxRow } from '@/components/shell/mailbox/MailboxRow';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import { apiFetch } from '@/utils/api-client';
import { RichBlocks } from '../RichBlocks';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
let root: Root, container: HTMLDivElement, item: ApprovalHubItem, block: RichCardBlock;
let phase: 'open' | 'accepted' | 'rejected' | 'closed_without_decision',
  owner: string,
  failedRead: boolean,
  proof: boolean;
let deadSource: boolean, duplicateSource: boolean;
let closedReason: unknown;
const coordinate = { threadId: 'repair-thread', messageId: 'original-repair-card' };
beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  deadSource = false;
  duplicateSource = false;
  phase = 'open';
  closedReason = undefined;
  owner = 'owner-1';
  failedRead = false;
  proof = true;
  item = {
    proposalId: 'eval-repair-original',
    sourceFeatureId: 'F266',
    ownerUserId: owner,
    requesterCatId: 'codex61-sol',
    summary: 'Eval repair · original evidence reader',
    createdAt: Date.now(),
    inlineApprovable: true,
    decisionMode: 'approve-reject',
    resolution: 'open',
    materialization: { state: 'not_started' },
    detail: {
      expectedChange: 'Repair the original evidence reader',
      costAndRollback: 'One review; revert this change',
      withdrawalCondition: 'Withdraw if the exact target changes',
      ownerRef: { ownerFeatureId: 'F188', ownerStateRef: 'owner:evidence-reader' },
      ownerAuthorizationRef: { ownerFeatureId: 'F188', ownerStateRef: 'authorization:evidence-reader' },
      targetVersionRef: {
        ownerFeatureId: 'F188',
        ownerStateRef: 'asset:evidence-reader',
        assetKind: 'feature_component',
        assetId: 'F188:evidence-reader',
        version: 'exact-original-version',
      },
    },
    navigation: {
      state: 'anchored',
      originRef: { kind: 'message', threadId: coordinate.threadId, messageId: 'owner-source' },
      approvalCardRef: coordinate,
    },
  };
  block = {
    id: `eval-repair-proposal-${item.proposalId}`,
    kind: 'card',
    v: 1,
    title: item.summary,
    bodyMarkdown: String(item.detail.expectedChange),
    tone: 'warning',
    fields: [
      { label: '成本与回滚', value: String(item.detail.costAndRollback) },
      { label: '撤回条件', value: String(item.detail.withdrawalCondition) },
      { label: '精确目标', value: 'exact-original-version' },
    ],
    actions: [
      { label: '批准', action: 'eval-repair:approve', payload: { proposalId: item.proposalId } },
      { label: '拒绝', action: 'eval-repair:reject', payload: { proposalId: item.proposalId } },
    ],
    meta: { approval: { producerId: 'F266', canonicalProposalId: item.proposalId } },
  };
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (failedRead) return Response.json({ error: 'unavailable' }, { status: 503 });
    if (String(path) === '/api/session') return Response.json({ userId: owner });
    if (init?.method === 'POST') {
      phase = String(path).endsWith('/approve') ? 'accepted' : 'rejected';
      return Response.json({ status: phase, materialization: { status: 'materialized' } });
    }
    if (String(path).startsWith('/api/messages?'))
      return Response.json({
        messages: deadSource
          ? []
          : [
              {
                id: coordinate.messageId,
                catId: 'codex61-sol',
                timestamp: item.createdAt,
                extra: { rich: { blocks: duplicateSource ? [block, block] : [block] } },
              },
            ],
        hasMore: false,
      });
    if (String(path).includes('/approval-hub/pending'))
      return Response.json({ items: phase === 'open' ? [item] : [], count: phase === 'open' ? 1 : 0 });
    if (String(path).includes('/approval-hub/settled'))
      return Response.json({
        items:
          phase === 'open'
            ? []
            : [
                {
                  ...item,
                  resolution: phase,
                  ...(closedReason !== undefined ? { closedReason } : {}),
                  materialization:
                    phase !== 'accepted'
                      ? { state: 'not_started' }
                      : proof
                        ? { state: 'succeeded', effectProofRef: 'custody:original-repair' }
                        : { state: 'outcome_unknown' },
                  decidedAt: Date.now(),
                  decidedBy: owner,
                  detail: { ...item.detail, ...(proof ? { canonicalEffectProofRef: 'custody:original-repair' } : {}) },
                },
              ],
      });
    const read = okRead(phase === 'open' ? [approvalRow(item)] : []);
    return Response.json(read.kind === 'ok' ? read.read : null);
  });
  useApprovalHubStore.setState({
    items: [],
    pendingReadAvailable: false,
    error: null,
    decisionAttempts: {},
    deciding: {},
    isLoading: false,
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.mocked(apiFetch).mockReset();
});
async function render(entrance: 'Chat' | 'Inbox', original = block) {
  const row = approvalRow(item);
  const sessions = createApprovalSessions({
    readsStarted: () => 1,
    refetch: () => {},
    refreshStore: () => useApprovalHubStore.getState().fetchPending(),
    storeItems: () => useApprovalHubStore.getState().items,
    attempts: () => useApprovalHubStore.getState().decisionAttempts,
    latestRead: () => ({ result: okRead([row]), generation: 1 }),
    now: Date.now,
  });
  await act(async () =>
    root.render(
      entrance === 'Chat' ? (
        <RichBlocks blocks={[original]} publication={{ ...coordinate, messageRevision: 'v1' }} />
      ) : (
        <MailboxRow
          item={row}
          rowKey="repair"
          stale={false}
          expanded={false}
          hosted={{ sessions, ownerUserId: 'owner-1' }}
          readCurrent
          onToggle={() => {}}
          onOpen={() => {}}
        />
      ),
    ),
  );
}
it.each([
  'Chat',
  'Inbox',
] as const)('shows the original repair content and submits through its original %s writer', async (entrance) => {
  await render(entrance);
  const cost = Array.from(container.querySelectorAll('p, dd')).find(
    (element) => element.textContent === item.detail.costAndRollback,
  );
  expect(cost).not.toBeUndefined();
  expect(cost?.closest('details')).toBeNull();
  expect(container.textContent).toContain('Withdraw if the exact target changes');
  expect(container.textContent).not.toContain('原提议未说明原因');
  const approve = container.querySelector<HTMLButtonElement>('[data-testid="approve-btn"]');
  expect(approve?.disabled).toBe(false);
  await act(async () => approve?.click());
  expect(
    vi
      .mocked(apiFetch)
      .mock.calls.filter(([, init]) => init?.method === 'POST')
      .map(([path]) => path),
  ).toEqual(['/api/eval-repair-proposals/eval-repair-original/approve']);
});
it('keeps the owner-backed decision boundary on the original Inbox card', async () => {
  item = {
    ...item,
    detail: {
      ...item.detail,
      decisionExplanation: {
        schemaVersion: 1,
        expectedChange: 'Repair the original evidence reader',
        beforeSummary: 'The next review had no exact source.',
        afterSummary: 'The next review shows its exact source.',
        changeSetSummary: 'Source receipt, reading entry and recovery ship together.',
        attributionBoundary: 'This proves one exact use, not whole-program improvement.',
        independentVerification: 'A non-author replays the full owner journey.',
        rejectedCandidates: ['Infer the version from prose', 'Treat opening as adoption'],
        costAndRollback: 'One review; revert this change',
      },
    },
  };
  await render('Inbox');
  const explanation = container.querySelector('[data-testid="eval-repair-decision-explanation"]');
  expect(explanation).not.toBeNull();
  for (const value of [
    'The next review had no exact source.',
    'The next review shows its exact source.',
    'This proves one exact use, not whole-program improvement.',
    'A non-author replays the full owner journey.',
    'Infer the version from prose',
  ])
    expect(explanation?.textContent).toContain(value);
});
it('keeps a complete legacy flat decision boundary readable on the original Inbox card', async () => {
  item = {
    ...item,
    detail: {
      ...item.detail,
      beforeSummary: 'Legacy before',
      afterSummary: 'Legacy after',
      changeSetSummary: 'Legacy change set',
      attributionBoundary: 'Legacy attribution boundary',
      independentVerification: 'Legacy independent verification',
      rejectedCandidates: ['Legacy rejected alternative'],
    },
  };
  await render('Inbox');
  const explanation = container.querySelector('[data-testid="eval-repair-decision-explanation"]');
  for (const value of [
    'Legacy before',
    'Legacy after',
    'Legacy attribution boundary',
    'Legacy independent verification',
    'Legacy rejected alternative',
  ])
    expect(explanation?.textContent).toContain(value);
});
it('keeps a canonical cold result on the original Chat card without allowing another decision', async () => {
  phase = 'accepted';
  await render('Chat');
  expect(container.textContent).toContain('修复工作已发起');
  expect(container.textContent).not.toContain('任务已完成');
  expect(container.querySelector('[data-testid="approve-btn"]')).toBeNull();
});
it.each([
  'owner',
  'source',
  'target',
  'actions',
  'card',
  'read',
  'deleted',
  'duplicate',
] as const)('refuses a changed %s before the original Chat write', async (reason) => {
  await render('Chat');
  const approve = container.querySelector<HTMLButtonElement>('[data-testid="approve-btn"]');
  expect(approve).not.toBeNull();
  if (reason === 'owner') owner = 'foreign-owner';
  if (reason === 'source') item = { ...item, requesterCatId: 'another-cat' };
  if (reason === 'target')
    item = {
      ...item,
      detail: {
        ...item.detail,
        targetVersionRef: { ...(item.detail.targetVersionRef as Record<string, unknown>), version: 'changed-version' },
      },
    };
  if (reason === 'actions')
    block = {
      ...block,
      actions: [
        ...(block.actions ?? []),
        { label: 'Other', action: 'eval-repair:approve', payload: { proposalId: 'another' } },
      ],
    };
  if (reason === 'card')
    item = {
      ...item,
      navigation: { ...item.navigation, approvalCardRef: { ...coordinate, messageId: 'another-card' } },
    } as ApprovalHubItem;
  if (reason === 'read') failedRead = true;
  if (reason === 'deleted') deadSource = true;
  if (reason === 'duplicate') duplicateSource = true;
  if (reason === 'actions') await render('Chat');
  await act(async () => approve?.click());
  expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
});

it('does not claim repair delivery from acceptance without its canonical custody proof', async () => {
  phase = 'accepted';
  proof = false;
  await render('Chat');
  expect(container.textContent).toContain('效果暂未确认');
  expect(container.textContent).not.toContain('修复工作已发起');
  expect(container.querySelector('[data-testid="approve-btn"]')).toBeNull();
});

it.each([
  'withdrawn',
  'expired',
] as const)('preserves a canonical %s close reason in the original Chat result', async (reason) => {
  phase = 'closed_without_decision';
  closedReason = reason;
  await render('Chat');
  expect(container.querySelector('[data-testid="decision-result-dot"]')?.getAttribute('data-status')).toBe(reason);
  expect(container.querySelector('[data-testid="decision-result-label"]')?.textContent).toContain(
    reason === 'withdrawn' ? '已撤回' : '已过期',
  );
});

it.each(['unknown-reason', 'accepted-with-withdrawal'])('does not propagate %s as a Chat closure', async (kind) => {
  phase = kind === 'unknown-reason' ? 'closed_without_decision' : 'accepted';
  closedReason = kind === 'unknown-reason' ? 'arbitrary-reason' : 'withdrawn';
  await render('Chat');
  expect(container.querySelector('[data-testid="decision-result-dot"]')?.getAttribute('data-status')).not.toBe(
    'withdrawn',
  );
  expect(container.textContent).not.toContain('已撤回');
});
