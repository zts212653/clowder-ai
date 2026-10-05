import type { ApprovalHubItem, UnifiedAttentionReadV1, UnifiedAttentionVisibleApproval } from '@cat-cafe/shared';
import type { MailboxRead } from '../unified-mailbox-state';
import { matchHostedApproval } from './approval-match';
import type { CanonicalRead, ReadEvidence, SettledLookup } from './approval-reconcile';
import { lookupSettled as lookupSettledHistory, type SettledLookupInput } from './settled-lookup';

/**
 * F322 S3-2b-1c: what one canonical re-read, made after a write, can say about one approval.
 *
 * `ReadEvidence` is what the reconciler decides from, so this says no more than the read proved:
 *  - listed: "present", and `aligned` only when the Approval Hub store holds the same decision (the matcher's verdict, for
 *    every listed copy). The store's copy is what the original card acts on; two copies that differ are not one decision;
 *  - not listed: "absent", and `exhaustive` only when the approvals source says it was read completely, the read's own
 *    consistency was verified and neither the page nor the approvals side has more rows. A first page that does not list a
 *    row says nothing about a row further down. The settled history is asked, and only for this case, for exactly this
 *    owner, producer and proposal;
 *  - another owner's read proves nothing about this card, and its rows and history are never consulted;
 *  - a failed read has no rows, so there is no other owner to be fooled by: it carries its reason, and a read that is still
 *    in flight is not a read at all (a failure to read, never a presence or an absence).
 */
export interface ApprovalAddress {
  sourceFeatureId: string;
  proposalId: string;
}

export interface BuildReadEvidenceInput {
  /** The panel's own number for this read (`UnifiedAttentionView.resultGeneration`). */
  generation: number;
  result: MailboxRead;
  address: ApprovalAddress;
  /** The owner the card was shown to. */
  shownToOwnerUserId: string;
  /** What the Approval Hub store holds now, read after its own refresh. */
  storeItems: readonly ApprovalHubItem[];
  /** The moment of asking: expiry is judged here. */
  now: number;
  /** The exact settled lookup; injectable for tests. */
  lookupSettled?: (input: SettledLookupInput) => Promise<SettledLookup>;
}

const UNAVAILABLE: SettledLookup = { kind: 'unavailable' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every copy of this approval the read lists. A row that carries no readable approval is not this approval. */
export function listedCopies(
  read: UnifiedAttentionReadV1,
  address: ApprovalAddress,
): UnifiedAttentionVisibleApproval[] {
  return read.items.flatMap((item) => {
    const approval: unknown = isRecord(item) ? item.approval : undefined;
    return isRecord(approval) &&
      approval.proposalId === address.proposalId &&
      approval.sourceFeatureId === address.sourceFeatureId
      ? [approval as UnifiedAttentionVisibleApproval]
      : [];
  });
}

/**
 * Every listed copy is the same decision as the store's (and at least one is listed). Used twice, so it is one rule: after a
 * write, to judge a re-read, and at the moment of a press, to judge the read the user is looking at.
 */
export function listedCopiesAligned(
  read: UnifiedAttentionReadV1,
  address: ApprovalAddress,
  storeItems: readonly ApprovalHubItem[],
  now: number,
): boolean {
  const copies = listedCopies(read, address);
  return (
    copies.length > 0 &&
    copies.every(
      (copy) =>
        matchHostedApproval({ read: copy, readOwnerUserId: read.identity.ownerUserId, storeItems, now }).kind ===
        'matched',
    )
  );
}

/** Whether the read can say an approval that is not on the page is not anywhere. */
function approvalsReadInFull(read: UnifiedAttentionReadV1): boolean {
  const { approvals } = read.sources;
  return (
    approvals.status === 'available' &&
    approvals.exhaustiveness === 'complete' &&
    read.consistency.state === 'verified' &&
    read.page.hasMore === false &&
    read.page.hasMoreApprovals !== true
  );
}

export async function buildReadEvidence(input: BuildReadEvidenceInput): Promise<ReadEvidence> {
  const { generation, result, address, shownToOwnerUserId, storeItems, now } = input;
  const lookup = input.lookupSettled ?? lookupSettledHistory;

  if (result.kind !== 'ok') {
    const reason = result.kind === 'failed' ? result.reason : 'unavailable';
    return { generation, sameOwner: true, result: { kind: 'failed', reason }, settled: UNAVAILABLE };
  }

  const { read } = result;
  const readOwner = read.identity.ownerUserId;
  if (readOwner !== shownToOwnerUserId) {
    const unconsulted: CanonicalRead = { kind: 'absent', exhaustive: false };
    return { generation, sameOwner: false, result: unconsulted, settled: UNAVAILABLE };
  }

  if (listedCopies(read, address).length > 0) {
    const aligned = listedCopiesAligned(read, address, storeItems, now);
    return { generation, sameOwner: true, result: { kind: 'present', aligned }, settled: UNAVAILABLE };
  }

  const settled = await lookup({
    ownerUserId: readOwner,
    sourceFeatureId: address.sourceFeatureId,
    proposalId: address.proposalId,
  });
  return {
    generation,
    sameOwner: true,
    result: { kind: 'absent', exhaustive: approvalsReadInFull(read) },
    settled,
  };
}
