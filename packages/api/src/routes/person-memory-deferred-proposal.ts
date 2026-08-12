import type {
  DeferredPersonMemoryReceipt,
  PersonIdentityDraft,
  PersonMemoryResolvedSourceBundle,
} from '@cat-cafe/shared';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { DeferredPersonMemoryReceiptStore } from '../domains/memory/DeferredPersonMemoryReceiptStore.js';
import {
  eligibleOwnerMessage,
  explicitlyConfirmsAccuracy,
} from '../domains/memory/people/PersonMemorySourceBundleResolver.js';
import { proposalPersonMemoryDeltaFingerprint } from '../domains/memory/people/person-memory-delta-lineage.js';
import { normalizeCandidatePhrase } from '../domains/memory/proactive-memory-lexical-noise.js';
import type { PersonMemoryProposalFailure } from './person-memory-proposal-preflight.js';
import type { ProposePersonMemoryBody } from './person-memory-proposal-source-contract.js';

type ReceiptStore = Pick<DeferredPersonMemoryReceiptStore, 'get'>;
type ReceiptResolution =
  | { status: 'ok'; value: DeferredPersonMemoryReceipt | null }
  | { status: 'error'; failure: PersonMemoryProposalFailure };
type DeferredSourceCoordinate = NonNullable<DeferredPersonMemoryReceipt['sourceCoordinates']>[number];
type ProposalResolvedSource = PersonMemoryResolvedSourceBundle['sources'][number];

function receiptTargetsProposalPerson(
  receipt: DeferredPersonMemoryReceipt,
  targetPersonId: string | undefined,
  person: PersonIdentityDraft,
): boolean {
  const normalizedSubjects = [person.displayName, ...person.privateAliases].map(normalizeCandidatePhrase);
  if (!receipt.normalizedSubject || !normalizedSubjects.includes(receipt.normalizedSubject)) return false;
  if (receipt.registryBinding?.kind === 'registered_entity') {
    return person.workspaceEntityLink?.entityRef === receipt.registryBinding.ref;
  }
  return receipt.registryBinding?.kind === 'registered_person' && targetPersonId === receipt.registryBinding.ref;
}

function deferredCoordinateKey(coordinate: DeferredSourceCoordinate): string {
  const base = `${coordinate.sourceRef.threadId}\0${coordinate.sourceRef.messageId}\0${coordinate.resolvedDigest}`;
  if (coordinate.kind === 'message') {
    return `message\0${base}`;
  }
  return `attachment\0${base}\0${coordinate.attachmentLocator.surface}\0${coordinate.attachmentLocator.index}`;
}

function proposalSourceKey(source: ProposalResolvedSource): string | null {
  if (source.kind === 'message_text') {
    return `message\0${source.sourceRef.threadId}\0${source.sourceRef.messageId}\0${source.resolvedDigest}`;
  }
  if (source.kind === 'message_attachment') {
    return (
      `attachment\0${source.sourceRef.threadId}\0${source.sourceRef.messageId}\0${source.resolvedDigest}` +
      `\0${source.attachmentLocator.surface}\0${source.attachmentLocator.index}`
    );
  }
  return null;
}

function proposalUsesExactDeferredSources(
  coordinates: readonly DeferredSourceCoordinate[],
  sources: readonly ProposalResolvedSource[],
): boolean {
  const expected = coordinates.map(deferredCoordinateKey).sort();
  const actual = sources.map(proposalSourceKey);
  return !actual.includes(null) && JSON.stringify(expected) === JSON.stringify(actual.sort());
}

async function confirmationRemainsEligible(
  coordinate: DeferredSourceCoordinate,
  ownerUserId: string,
  messageStore: IMessageStore,
): Promise<boolean> {
  if (coordinate.kind !== 'message_attachment' || !coordinate.confirmationSourceRef) return true;
  const confirmation = await messageStore.getById(coordinate.confirmationSourceRef.messageId);
  return (
    eligibleOwnerMessage(confirmation, { ownerUserId }) &&
    confirmation.threadId === coordinate.confirmationSourceRef.threadId &&
    explicitlyConfirmsAccuracy(confirmation)
  );
}

async function receiptMatchesProposal(input: {
  receipt: DeferredPersonMemoryReceipt;
  ownerUserId: string;
  targetPersonId?: string;
  person: PersonIdentityDraft;
  sourceBundle: PersonMemoryResolvedSourceBundle;
  messageStore: IMessageStore;
}): Promise<boolean> {
  const { receipt } = input;
  if (!receiptTargetsProposalPerson(receipt, input.targetPersonId, input.person)) return false;
  if (!receipt.sourceCoordinates || !receipt.originMessageRef) return false;
  const origin = await input.messageStore.getById(receipt.originMessageRef.messageId);
  if (
    !eligibleOwnerMessage(origin, { ownerUserId: input.ownerUserId }) ||
    origin.threadId !== receipt.originMessageRef.threadId
  ) {
    return false;
  }
  const proposalFingerprint = proposalPersonMemoryDeltaFingerprint({
    targetPersonId: input.targetPersonId,
    person: input.person,
    sourceBundle: input.sourceBundle,
  });
  if (!proposalFingerprint || proposalFingerprint !== receipt.dedupeHash) return false;
  if (!proposalUsesExactDeferredSources(receipt.sourceCoordinates, input.sourceBundle.sources)) return false;
  for (const coordinate of receipt.sourceCoordinates) {
    if (!(await confirmationRemainsEligible(coordinate, input.ownerUserId, input.messageStore))) return false;
  }
  return true;
}

export async function resolveDeferredProposalReceipt(input: {
  lineage: ProposePersonMemoryBody['deferredReceipt'];
  ownerUserId: string;
  requesterCatId: string;
  targetPersonId?: string;
  person: PersonIdentityDraft;
  sourceBundle: PersonMemoryResolvedSourceBundle;
  messageStore: IMessageStore;
  receiptStore?: ReceiptStore;
}): Promise<ReceiptResolution> {
  if (!input.lineage) return { status: 'ok', value: null };
  if (!input.receiptStore) {
    return { status: 'error', failure: { statusCode: 503, payload: { error: 'deferred_receipt_unavailable' } } };
  }
  const receipt = await input.receiptStore.get(input.ownerUserId, input.lineage.receiptId);
  if (
    !receipt ||
    receipt.state !== 'claimed' ||
    receipt.claimId !== input.lineage.claimId ||
    receipt.requesterCatId !== input.requesterCatId ||
    !receipt.originMessageRef ||
    (receipt.claimUntil ?? 0) <= Date.now()
  ) {
    return { status: 'error', failure: { statusCode: 409, payload: { error: 'deferred_receipt_conflict' } } };
  }
  return (await receiptMatchesProposal({ ...input, receipt }))
    ? { status: 'ok', value: receipt }
    : {
        status: 'error',
        failure: { statusCode: 409, payload: { error: 'deferred_receipt_source_conflict' } },
      };
}
