import { expect, it } from 'vitest';
import { matchHostedApproval } from '../approval-match';
import { describeReconcile } from '../approval-reconcile';
import { createApprovalSessions } from '../approval-sessions';
import { approvalRow, NOW, OWNER, okRead, storeItem, visibleApproval } from './mailbox-fixtures';

it('holds an unknown transport result even when the proposal is still in the read', () => {
  expect(describeReconcile({ kind: 'still_open', write: { outcome: 'unknown' } }).actions).toBe('held');
});

it('refuses changed proposal content even when title and timestamp are unchanged', () => {
  const item = storeItem({ detail: { reason: '用户看到的原因', preferredCats: ['codex61-sol'] } });
  const changed = { ...item, detail: { ...item.detail, preferredCats: ['codex-sol'] } };
  expect(
    matchHostedApproval({ read: visibleApproval(item), readOwnerUserId: OWNER, storeItems: [changed], now: NOW }).kind,
  ).toBe('unmatched');
});

it('refuses conflicting repeated store copies of one canonical decision', () => {
  const item = storeItem();
  expect(
    matchHostedApproval({
      read: visibleApproval(item),
      readOwnerUserId: OWNER,
      storeItems: [item, { ...item, summary: 'changed' }],
      now: NOW,
    }).kind,
  ).toBe('unmatched');
});

it('refuses a row when the approval source is unavailable even if cached copies align', () => {
  const item = storeItem();
  const result = okRead([approvalRow(item)]);
  if (result.kind !== 'ok') throw new Error('fixture');
  result.read.sources.approvals.status = 'unavailable';
  const sessions = createApprovalSessions({
    readsStarted: () => 1,
    refetch: () => {},
    refreshStore: async () => {},
    storeItems: () => [item],
    attempts: () => ({}),
    latestRead: () => ({ result, generation: 1 }),
    now: () => NOW,
  });
  const session = sessions.open({ ownerUserId: OWNER, approval: visibleApproval(item), decisionRef: 'approval:p-1' });
  expect(sessions.authorize(session.key)).toBe(false);
});
