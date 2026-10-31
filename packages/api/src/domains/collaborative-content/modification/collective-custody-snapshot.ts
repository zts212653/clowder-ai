import { createHash } from 'node:crypto';
import {
  COLLECTIVE_CUSTODY_MAX_BYTES,
  type CollectiveModificationRecord,
  type ContentTextProposal,
  collectiveModificationRecordSchema,
  respondCollectiveContentTextSchema,
} from '@cat-cafe/shared';
import { z } from 'zod';
import { collectiveContentReceiptSchema } from '../../video-studio/content-owner/collective-snapshot.js';
import { type CollectiveDisposition, collectiveAcceptanceIntentSchema } from './collective-acceptance-store.js';
import { collectiveResolutionReceipt } from './collective-resolution.js';

const id = z.string().min(1).max(256);
const positive = z.number().int().positive().safe();
const time = z.number().int().nonnegative().safe();
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const proposalSchema = z
  .object({
    proposalRef: id,
    requestId: id,
    revision: positive,
    operationId: z.string().uuid(),
    baseRevision: digest,
    resultRevision: digest,
    edits: respondCollectiveContentTextSchema.shape.edits,
    response: z.string().trim().min(1).max(8000),
    authorCatId: id,
    createdAt: time,
    receiptRef: id,
  })
  .strict();
const dispositionBase = z.object({
  kind: z.literal('collective-artifact'),
  intent: collectiveAcceptanceIntentSchema,
  createdAt: time,
});
const dispositionSchema: z.ZodType<CollectiveDisposition> = z.discriminatedUnion('state', [
  dispositionBase.extend({ state: z.literal('pending') }).strict(),
  dispositionBase
    .extend({ state: z.literal('failed'), failedAt: time, reason: z.literal('owner_effect_absent') })
    .strict(),
  dispositionBase
    .extend({ state: z.literal('accepted'), acceptedAt: time, receipt: collectiveContentReceiptSchema })
    .strict(),
]);
export interface CollectiveModificationSnapshot {
  v: 1;
  requests: Omit<CollectiveModificationRecord, 'execution'>[];
  proposals: {
    requestId: string;
    revision: number;
    operationId: string;
    fingerprint: string;
    proposal: ContentTextProposal;
  }[];
  dispositions: CollectiveDisposition[];
}
const snapshotSchema: z.ZodType<CollectiveModificationSnapshot> = z
  .object({
    v: z.literal(1),
    requests: z.array(collectiveModificationRecordSchema.omit({ execution: true }).strict()).max(10000),
    proposals: z
      .array(
        z
          .object({
            requestId: id,
            revision: positive,
            operationId: z.string().uuid(),
            fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
            proposal: proposalSchema,
          })
          .strict(),
      )
      .max(10000),
    dispositions: z.array(dispositionSchema).max(10000),
  })
  .strict();

export function validateCollectiveModificationSnapshot(
  unsafe: unknown,
  scopeRef: string,
  contentRef: string,
): CollectiveModificationSnapshot {
  const encoded = JSON.stringify(unsafe);
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > COLLECTIVE_CUSTODY_MAX_BYTES)
    throw new Error('Collective modifications exceed their admitted bound');
  const snapshot = snapshotSchema.parse(unsafe);
  const requests = validateRequests(snapshot.requests, scopeRef, contentRef);
  const proposals = validateProposals(snapshot.proposals, requests);
  for (const request of requests.values()) {
    const resolution = request.resolution;
    if (resolution?.kind === 'rejected' && proposals.get(resolution.proposalRef ?? '')?.requestId !== request.requestId)
      throw new Error('Collective rejection candidate missing');
  }
  validateDispositions(snapshot, requests, proposals, scopeRef, contentRef);
  return snapshot;
}

type RequestMap = Map<string, Omit<CollectiveModificationRecord, 'execution'>>;
type ProposalRow = CollectiveModificationSnapshot['proposals'][number];
function validateRequests(
  items: CollectiveModificationSnapshot['requests'],
  scopeRef: string,
  contentRef: string,
): RequestMap {
  const requests = new Map<string, Omit<CollectiveModificationRecord, 'execution'>>();
  for (const request of items) {
    const expected = `f309-modification-${createHash('sha256')
      .update(JSON.stringify(['collective-artifact', scopeRef, request.source.requestEventId]))
      .digest('hex')}`;
    if (
      requests.has(request.requestId) ||
      request.requestId !== expected ||
      request.source.scopeRef !== scopeRef ||
      request.source.contentRef !== contentRef
    )
      throw new Error('Collective modification scope mismatch');
    const resolution = request.resolution;
    if (
      resolution &&
      (request.state !== 'cancelled' ||
        request.revision !== resolution.expectedRequestRevision + 1 ||
        resolution.receiptRef !== collectiveResolutionReceipt(scopeRef, request.requestId, resolution) ||
        (resolution.kind === 'cancelled' &&
          ![request.requestingHumanId, request.target.humanId].includes(resolution.actorHumanId)))
    )
      throw new Error('Collective request resolution receipt mismatch');
    requests.set(request.requestId, request);
  }
  return requests;
}
function validateProposals(items: ProposalRow[], requests: RequestMap): Map<string, ContentTextProposal> {
  const proposals = new Map<string, ContentTextProposal>();
  const revisions = new Map<string, number>();
  const operations = new Set<string>();
  for (const row of items) {
    const request = validateProposalReference(row, requests, revisions);
    const proposal = row.proposal;
    const key = `${request.requestId}:${row.operationId}`;
    if (operations.has(key)) throw new Error('Duplicate Collective proposal operation');
    operations.add(key);
    const command = respondCollectiveContentTextSchema.parse({
      requestId: row.requestId,
      operationId: row.operationId,
      expectedOwnerRevision: request.source.ownerRevision,
      expectedProposalRevision: row.revision - 1,
      baseRevision: proposal.baseRevision,
      edits: proposal.edits,
      response: proposal.response,
    });
    if (
      createHash('sha256')
        .update(JSON.stringify([command, proposal.authorCatId]))
        .digest('hex') !== row.fingerprint
    )
      throw new Error('Collective proposal fingerprint mismatch');
    proposals.set(proposal.proposalRef, proposal);
    revisions.set(request.requestId, row.revision);
  }
  return proposals;
}
function validateProposalReference(row: ProposalRow, requests: RequestMap, revisions: Map<string, number>) {
  const request = requests.get(row.requestId);
  const proposal = row.proposal;
  if (
    !request ||
    row.revision !== (revisions.get(row.requestId) ?? 0) + 1 ||
    row.revision !== proposal.revision ||
    row.operationId !== proposal.operationId ||
    proposal.requestId !== request.requestId ||
    proposal.authorCatId !== request.target.catId ||
    proposal.baseRevision !== request.source.blobDigest ||
    proposal.proposalRef !== `content-patch:${request.requestId}:${row.revision}` ||
    proposal.receiptRef !== `${proposal.proposalRef}#prepared`
  )
    throw new Error('Collective proposal reference mismatch');
  return request;
}
function validateDispositions(
  snapshot: CollectiveModificationSnapshot,
  requests: RequestMap,
  proposals: Map<string, ContentTextProposal>,
  scopeRef: string,
  contentRef: string,
) {
  const dispositions = new Set<string>();
  const winners = new Set<string>();
  const acceptedRequests = new Set<string>();
  for (const item of snapshot.dispositions) {
    const request = validateDispositionReference(item, requests, proposals, dispositions, scopeRef, contentRef);
    const intent = item.intent;
    dispositions.add(intent.dispositionId);
    if (item.state !== 'failed') {
      if (winners.has(request.requestId)) throw new Error('Duplicate Collective adoption winner');
      winners.add(request.requestId);
    }
    if (item.state === 'accepted') {
      acceptedRequests.add(request.requestId);
      validateAcceptedReceipt(item, request, scopeRef, contentRef);
    }
  }
  for (const request of snapshot.requests)
    if (request.state === 'accepted' && !acceptedRequests.has(request.requestId))
      throw new Error('Collective accepted request has no receipt');
}
function validateDispositionReference(
  item: CollectiveDisposition,
  requests: RequestMap,
  proposals: Map<string, ContentTextProposal>,
  dispositions: Set<string>,
  scopeRef: string,
  contentRef: string,
) {
  const intent = item.intent;
  const request = requests.get(intent.requestId);
  const proposal = proposals.get(intent.candidateRef);
  if (
    !request ||
    !proposal ||
    proposal.requestId !== request.requestId ||
    intent.scopeRef !== scopeRef ||
    intent.contentRef !== contentRef ||
    intent.ownerUserId !== request.ownerUserId ||
    intent.expectedOwnerRevision !== request.source.ownerRevision ||
    intent.baseDigest !== request.source.blobDigest ||
    intent.resultDigest !== proposal.resultRevision ||
    dispositions.has(intent.dispositionId)
  )
    throw new Error('Collective disposition reference mismatch');
  return request;
}
function validateAcceptedReceipt(
  item: Extract<CollectiveDisposition, { state: 'accepted' }>,
  request: Omit<CollectiveModificationRecord, 'execution'>,
  scopeRef: string,
  contentRef: string,
) {
  const intent = item.intent;
  const receipt = item.receipt;
  const context = receipt.operationContext;
  if (
    receipt.contentRef !== contentRef ||
    receipt.previousOwnerRevision !== intent.expectedOwnerRevision ||
    receipt.ownerRevision !== intent.expectedOwnerRevision + 1 ||
    receipt.operationId !== intent.ownerOperationId ||
    receipt.blobDigest !== intent.resultDigest ||
    receipt.actor.kind !== 'human' ||
    receipt.actor.actorId !== intent.actorHumanId ||
    context?.kind !== 'collective-artifact:apply' ||
    context.scopeRef !== scopeRef ||
    context.actorHumanId !== intent.actorHumanId ||
    context.dispositionId !== intent.dispositionId ||
    context.requestDigest !== intent.requestDigest ||
    context.custodyRevision !== intent.custodyRevision ||
    request.state !== 'accepted'
  )
    throw new Error('Collective accepted receipt mismatch');
}

export function rebindCollectiveModificationSnapshot(
  snapshot: CollectiveModificationSnapshot,
  ownerUserId: string,
): CollectiveModificationSnapshot {
  return {
    ...snapshot,
    requests: snapshot.requests.map((request) => ({ ...request, ownerUserId })),
    dispositions: snapshot.dispositions.map((item) => ({ ...item, intent: { ...item.intent, ownerUserId } })),
  };
}
