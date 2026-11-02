import { beforeEach, expect, it, vi } from 'vitest';
import { readApprovalProducerBody } from '@/lib/approval-producer-read';
import { approvalResultRead } from '@/lib/approval-result-read';
import { apiFetch } from '@/utils/api-client';
import { observeApiSessionOwner } from '@/utils/api-session-identity';
import { retainSettledResult } from '../approval-history-page-source';
import { lookupCreatedThread } from '../created-thread-lookup';
import { lookupDisplayedSettled, lookupSettled, SETTLED_LOOKUP_PATH } from '../settled-lookup';
import type { SettledResultItem } from '../settled-results-source';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

const key = { owner: 'owner', producer: 'F128', proposalId: 'proposal' };
const ask = { ownerUserId: key.owner, sourceFeatureId: key.producer, proposalId: key.proposalId };
const proposalPath = '/api/proposals/proposal';
const settled: SettledResultItem = {
  proposalId: key.proposalId,
  sourceFeatureId: 'F128',
  ownerUserId: key.owner,
  requesterCatId: 'codex61-sol',
  summary: 'The original conversation',
  detail: {
    createdThreadId: 'child',
    createdThreadProof: { proposalId: key.proposalId, ownerUserId: key.owner, threadId: 'child' },
  },
  navigation: { state: 'legacy_unanchored' },
  createdAt: 1,
  decidedAt: 2,
  decidedBy: key.owner,
  resolution: 'accepted',
  materialization: { state: 'succeeded', effectProofRef: 'thread:child' },
};
let liveChild: string;
beforeEach(() => {
  approvalResultRead.clear();
  observeApiSessionOwner(key.owner);
  liveChild = 'child';
  vi.mocked(apiFetch)
    .mockReset()
    .mockImplementation(async (path) => {
      if (path === proposalPath)
        return Response.json({
          proposal: {
            proposalId: key.proposalId,
            status: 'approved',
            createdBy: key.owner,
            createdThreadId: liveChild,
          },
        });
      if (path === `/api/threads/${liveChild}`)
        return Response.json({ id: liveChild, createdBy: key.owner, createdFromProposalId: key.proposalId });
      if (path === SETTLED_LOOKUP_PATH) return Response.json({ items: [settled] });
      throw new Error(`Unexpected request: ${path}`);
    });
});

it('keeps the first native read when a later shared settled proof reaches multiple display consumers', async () => {
  await readApprovalProducerBody(key, proposalPath);
  retainSettledResult(settled);
  const results = await Promise.all(Array.from({ length: 3 }, () => lookupDisplayedSettled(ask)));
  expect(results).toEqual(
    Array.from({ length: 3 }, () => ({
      kind: 'found',
      terminal: { resolution: 'accepted', decidedAt: 2, decidedBy: key.owner, threadId: 'child' },
    })),
  );
  expect(vi.mocked(apiFetch).mock.calls.filter(([path]) => path === proposalPath)).toHaveLength(1);
});

it('reads no HTTP when the owner-bound shared page already verified the created conversation', async () => {
  retainSettledResult(settled);
  await expect(lookupDisplayedSettled(ask)).resolves.toMatchObject({
    kind: 'found',
    terminal: { threadId: 'child' },
  });
  expect(apiFetch).not.toHaveBeenCalled();
});

it('uses the legacy settled binding and checks its exact child without fetching the original proposal again', async () => {
  await readApprovalProducerBody(key, proposalPath);
  retainSettledResult({ ...settled, detail: { createdThreadId: 'child' } });
  await expect(lookupDisplayedSettled(ask)).resolves.toMatchObject({
    kind: 'found',
    terminal: { threadId: 'child' },
  });
  expect(vi.mocked(apiFetch).mock.calls.map(([path]) => path)).toEqual([proposalPath, '/api/threads/child']);
});

it.each([
  { id: 'another-child', createdBy: key.owner, createdFromProposalId: key.proposalId },
  { id: 'child', createdBy: 'another-owner', createdFromProposalId: key.proposalId },
  { id: 'child', createdBy: key.owner, createdFromProposalId: 'another-proposal' },
])('does not confirm a legacy binding against a mismatched child %j', async (child) => {
  retainSettledResult({ ...settled, detail: { createdThreadId: 'child' } });
  vi.mocked(apiFetch).mockResolvedValue(Response.json(child));
  await expect(lookupDisplayedSettled(ask)).resolves.toMatchObject({
    kind: 'found',
    terminal: { effectUnknown: true },
  });
  expect(approvalResultRead.isCurrent(key, 'verified-thread')).toBe(false);
});

it('still checks the original producer and exact child for fresh post-write confirmation', async () => {
  retainSettledResult(settled);
  liveChild = 'fresh-child';
  await expect(lookupSettled(ask)).resolves.toMatchObject({
    kind: 'found',
    terminal: { threadId: 'fresh-child' },
  });
  expect(vi.mocked(apiFetch).mock.calls.map(([path]) => path)).toEqual([
    SETTLED_LOOKUP_PATH,
    proposalPath,
    '/api/threads/fresh-child',
  ]);
});

it('does not reuse a verified child after changing the browser owner', async () => {
  retainSettledResult(settled);
  observeApiSessionOwner('another-owner');
  await expect(lookupDisplayedSettled(ask)).resolves.toEqual({ kind: 'unavailable' });
  expect(apiFetch).not.toHaveBeenCalled();
});

it('rechecks a display proof after it has been invalidated', async () => {
  retainSettledResult(settled);
  approvalResultRead.invalidateParts(key, ['verified-thread']);
  liveChild = 'updated-child';
  await expect(lookupCreatedThread(ask, { reuseProducerForDisplay: true })).resolves.toBe('updated-child');
  expect(vi.mocked(apiFetch).mock.calls.map(([path]) => path)).toEqual([proposalPath, '/api/threads/updated-child']);
});
