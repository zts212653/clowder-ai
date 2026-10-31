import { afterEach, expect, it, vi } from 'vitest';
import { INITIAL_RECONCILE } from '../approval-reconcile';
import type { ApprovalSession } from '../approval-sessions';
import { lookupCreatedThread } from '../created-thread-lookup';
import { mailboxRowKey, projectMailboxRows } from '../mailbox-rows';
import { approvalRow, OWNER, storeItem, visibleApproval } from './mailbox-fixtures';

const mocked = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: mocked.fetch }));
afterEach(() => mocked.fetch.mockReset());
const input = { ownerUserId: OWNER, sourceFeatureId: 'F128', proposalId: 'p-1' };
const proposal = { proposalId: 'p-1', createdBy: OWNER, status: 'approved', createdThreadId: 'child' };
it('proves an opened conversation only from the finalized producer binding and the exact Thread owner', async () => {
  mocked.fetch.mockImplementation(async (path: string) =>
    Response.json(
      path.startsWith('/api/proposals')
        ? { proposal }
        : { id: 'child', createdBy: OWNER, createdFromProposalId: 'p-1' },
    ),
  );
  expect(await lookupCreatedThread(input)).toBe('child');
  expect(mocked.fetch.mock.calls.every(([, init]) => !init?.method)).toBe(true);
});
it.each([
  { createdBy: 'other' },
  { createdFromProposalId: 'other' },
  { id: 'other' },
])('does not upgrade a Thread with a mismatched binding: %j', async (change) => {
  mocked.fetch.mockImplementation(async (path: string) =>
    Response.json(
      path.startsWith('/api/proposals')
        ? { proposal }
        : { id: 'child', createdBy: OWNER, createdFromProposalId: 'p-1', ...change },
    ),
  );
  expect(await lookupCreatedThread(input)).toBeNull();
});
it('does not turn an unavailable or still-pending producer into an opened conversation', async () => {
  for (const response of [
    Response.json({ proposal: { ...proposal, status: 'pending' } }),
    new Response(null, { status: 403 }),
  ]) {
    mocked.fetch.mockResolvedValue(response);
    expect(await lookupCreatedThread(input)).toBeNull();
  }
});
it('shows a repeated canonical decision once and keeps its result between the same neighboring items', () => {
  const item = storeItem();
  const row = approvalRow(item);
  const before = { ...row, approval: undefined, decisionRef: 'before' };
  const after = { ...row, approval: undefined, decisionRef: 'after' };
  const initial = projectMailboxRows([before, row, { ...row, decisionRef: 'alias-of-same-decision' }, after], [], []);
  expect(initial).toHaveLength(3);
  const session: ApprovalSession = {
    key: 'session',
    ownerUserId: OWNER,
    address: { sourceFeatureId: 'F128', proposalId: item.proposalId },
    decisionRef: row.decisionRef,
    approval: visibleApproval(item),
    model: { ...INITIAL_RECONCILE, state: { kind: 'unconfirmed', why: 'cannot_tell' } },
    notice: null,
  };
  const next = projectMailboxRows(
    [before, after],
    [session],
    initial.map((row) => row.key),
  );
  expect(next.map((row) => row.key)).toEqual([mailboxRowKey(before), mailboxRowKey(row), mailboxRowKey(after)]);
  expect(next[1].kind).toBe('retained');
});
