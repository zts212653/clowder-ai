/**
 * F322 S3-2b-1c: what one canonical re-read, made after a write, can say about one approval.
 *
 * The reconciler decides from `ReadEvidence`; this builds it. The builder must never say more than the read proved:
 *  - "present" is aligned only when the Approval Hub store holds the same decision (the matcher's verdict, not a guess);
 *  - "absent" is exhaustive only when the approvals source said it was read completely and the page had no more rows;
 *  - a settled row is looked up only for an absence, for exactly this owner, producer and proposal;
 *  - a read of another owner proves nothing, and a failed read has no rows to be fooled by.
 */
import type { ApprovalHubItem, UnifiedAttentionItemV1 } from '@cat-cafe/shared';
import { describe, expect, it, vi } from 'vitest';
import type { MailboxRead } from '../../unified-mailbox-state';
import type { SettledLookup } from '../approval-reconcile';
import { buildReadEvidence } from '../read-evidence';
import { NOW, OWNER, okRead as readOf, approvalRow as row, storeItem } from './mailbox-fixtures';

const address = { sourceFeatureId: 'F128', proposalId: 'p-1' };

function run(
  result: MailboxRead,
  options: { storeItems?: ApprovalHubItem[]; settled?: SettledLookup; shownTo?: string } = {},
) {
  const lookup = vi.fn(async (): Promise<SettledLookup> => options.settled ?? { kind: 'not_found' });
  const evidence = buildReadEvidence({
    generation: 4,
    result,
    address,
    shownToOwnerUserId: options.shownTo ?? OWNER,
    storeItems: options.storeItems ?? [],
    now: NOW,
    lookupSettled: lookup,
  });
  return { evidence, lookup };
}

describe('buildReadEvidence: the approval is still on the page', () => {
  it('is present and aligned when the store holds the same decision', async () => {
    const item = storeItem();
    const { evidence, lookup } = run(readOf([row(item)]), { storeItems: [item] });
    await expect(evidence).resolves.toEqual({
      generation: 4,
      sameOwner: true,
      result: { kind: 'present', aligned: true },
      settled: { kind: 'unavailable' },
    });
    // A row that is still listed needs no settled history.
    expect(lookup).not.toHaveBeenCalled();
  });

  it('is present but not aligned when the store has a different version of it', async () => {
    const { evidence } = run(readOf([row(storeItem())]), { storeItems: [storeItem({ summary: 'changed' })] });
    await expect(evidence).resolves.toMatchObject({ result: { kind: 'present', aligned: false } });
  });

  it('is present but not aligned when the store no longer holds it (an optimistic removal is not alignment)', async () => {
    const { evidence } = run(readOf([row(storeItem())]), { storeItems: [] });
    await expect(evidence).resolves.toMatchObject({ result: { kind: 'present', aligned: false } });
  });

  it('is not aligned when the store copy belongs to another owner', async () => {
    const { evidence } = run(readOf([row(storeItem())]), { storeItems: [storeItem({ ownerUserId: 'owner-2' })] });
    await expect(evidence).resolves.toMatchObject({ result: { kind: 'present', aligned: false } });
  });

  it('needs every listed copy of it to match: a duplicate that does not is not aligned', async () => {
    const item = storeItem();
    const other = storeItem({ summary: 'a second, different version' });
    const rows = [row(item), row(other, 'approval:p-1:v2')];
    const { evidence } = run(readOf(rows), { storeItems: [item] });
    await expect(evidence).resolves.toMatchObject({ result: { kind: 'present', aligned: false } });
  });

  it('finds the approval among other rows, by producer and proposal', async () => {
    const item = storeItem();
    const sameIdOtherProducer = storeItem({ sourceFeatureId: 'F221', summary: 'not this one' });
    const { evidence } = run(readOf([row(sameIdOtherProducer, 'approval:x'), row(item)]), { storeItems: [item] });
    await expect(evidence).resolves.toMatchObject({ result: { kind: 'present', aligned: true } });
  });
});

describe('buildReadEvidence: the approval is not on the page', () => {
  const settledFound: SettledLookup = {
    kind: 'found',
    terminal: { resolution: 'accepted', decidedAt: 7, decidedBy: OWNER },
  };

  it('asks the settled history for exactly this owner, producer and proposal, and carries its answer', async () => {
    const { evidence, lookup } = run(readOf([]), { settled: settledFound });
    await expect(evidence).resolves.toEqual({
      generation: 4,
      sameOwner: true,
      result: { kind: 'absent', exhaustive: true },
      settled: settledFound,
    });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith({ ownerUserId: OWNER, sourceFeatureId: 'F128', proposalId: 'p-1' });
  });

  it('carries "not found" and "unavailable" as they are', async () => {
    for (const settled of [{ kind: 'not_found' }, { kind: 'unavailable' }] as const) {
      const { evidence } = run(readOf([]), { settled });
      await expect(evidence).resolves.toMatchObject({ settled });
    }
  });

  it('is not exhaustive when the page says there are more rows', async () => {
    const { evidence } = run(readOf([], { page: { offset: 0, limit: 20, scope: 'known_rows', hasMore: true } }));
    await expect(evidence).resolves.toMatchObject({ result: { kind: 'absent', exhaustive: false } });
  });

  it('is not exhaustive when more approvals are known to exist, even if the page as a whole says no more', async () => {
    const page = { offset: 0, limit: 20, scope: 'known_rows' as const, hasMore: false, hasMoreApprovals: true };
    const { evidence } = run(readOf([], { page }));
    await expect(evidence).resolves.toMatchObject({ result: { kind: 'absent', exhaustive: false } });
  });

  it.each([
    'partial',
    'unknown',
  ] as const)('is not exhaustive when the approvals source was read %s', async (exhaustiveness) => {
    const base = readOf([]);
    if (base.kind !== 'ok') throw new Error('fixture');
    const result = readOf([], {
      sources: { ...base.read.sources, approvals: { ...base.read.sources.approvals, exhaustiveness } },
    });
    await expect(run(result).evidence).resolves.toMatchObject({ result: { kind: 'absent', exhaustive: false } });
  });

  it.each([
    'unavailable',
    'unauthenticated',
    'forbidden',
    'invalid',
  ] as const)('is not exhaustive when the approvals source status is %s', async (status) => {
    const base = readOf([]);
    if (base.kind !== 'ok') throw new Error('fixture');
    const result = readOf([], {
      sources: { ...base.read.sources, approvals: { ...base.read.sources.approvals, status } },
    });
    await expect(run(result).evidence).resolves.toMatchObject({ result: { kind: 'absent', exhaustive: false } });
  });

  it('is not exhaustive when the read could not verify its own consistency', async () => {
    const result = readOf([], { consistency: { state: 'uncertain', reasons: ['x'] } });
    await expect(run(result).evidence).resolves.toMatchObject({ result: { kind: 'absent', exhaustive: false } });
  });
});

describe('buildReadEvidence: reads that prove nothing about this card', () => {
  it('a read of another owner is not the same owner, and its rows and settled history are not consulted', async () => {
    const item = storeItem();
    const read = readOf([row(item)], { identity: { ownerUserId: 'owner-2' } });
    const { evidence, lookup } = run(read, { storeItems: [item] });
    const out = await evidence;
    expect(out.sameOwner).toBe(false);
    expect(out.settled).toEqual({ kind: 'unavailable' });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('a failed read carries its reason, has no rows, and asks for no settled history', async () => {
    for (const reason of ['unauthenticated', 'unavailable'] as const) {
      const { evidence, lookup } = run({ kind: 'failed', reason });
      await expect(evidence).resolves.toEqual({
        generation: 4,
        sameOwner: true,
        result: { kind: 'failed', reason },
        settled: { kind: 'unavailable' },
      });
      expect(lookup).not.toHaveBeenCalled();
    }
  });

  it('a read still loading is not a read: it is a failure to read, never a presence or an absence', async () => {
    const { evidence, lookup } = run({ kind: 'loading' });
    await expect(evidence).resolves.toMatchObject({ result: { kind: 'failed', reason: 'unavailable' } });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('an approval row without a readable approval is not the approval being asked about', async () => {
    const junk = { decisionRef: 'x', kind: 'judgment', summary: 's', linkedNeedsMe: [] } as UnifiedAttentionItemV1;
    const { evidence } = run(readOf([junk]));
    await expect(evidence).resolves.toMatchObject({ result: { kind: 'absent', exhaustive: true } });
  });
});
