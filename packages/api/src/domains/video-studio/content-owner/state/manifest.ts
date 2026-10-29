import { type CollectiveContentScopeV1, validateCollectiveContentScope } from '../collective-scope.js';
import { validateVideoProjectMediaScope } from '../project-media-scope.js';
import { validateContentOperationContext, validateVideoProjectScope } from '../project-scope.js';
import { validateContentPublication } from '../publication.js';
import type {
  ContentPublicationScopeV1,
  ContentSettlementReceiptV1,
  ProjectContentRevisionV1,
  VideoProjectMediaScopeV1,
  VideoProjectScopeV1,
} from '../types.js';

interface StoredOperationV1 {
  readonly fingerprint: `sha256:${string}`;
  readonly receiptId: string;
}

export interface ProjectContentStateV1 {
  readonly collectiveScope?: CollectiveContentScopeV1;
  readonly schemaVersion: 1;
  readonly contentRef: string;
  readonly mediaType: string;
  readonly currentOwnerRevision: number;
  readonly revisions: readonly ProjectContentRevisionV1[];
  readonly receipts: readonly ContentSettlementReceiptV1[];
  readonly operations: Readonly<Record<string, StoredOperationV1>>;
  readonly publicationScope?: ContentPublicationScopeV1;
  readonly projectScope?: VideoProjectScopeV1;
  readonly projectMediaScope?: VideoProjectMediaScopeV1;
}

export function parseProjectContentState(raw: string, expectedContentRef: string): ProjectContentStateV1 {
  return validateProjectContentState(JSON.parse(raw), expectedContentRef);
}

/** Validate the entire freshly decoded graph, including scopes, receipts and every revision. */
export function validateProjectContentState(parsed: unknown, expectedContentRef: string): ProjectContentStateV1 {
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || parsed.contentRef !== expectedContentRef) {
    throw invalidState(expectedContentRef);
  }
  if (
    !validIdentity(parsed.mediaType) ||
    !positiveRevision(parsed.currentOwnerRevision) ||
    !Array.isArray(parsed.revisions) ||
    !Array.isArray(parsed.receipts) ||
    !isRecord(parsed.operations)
  ) {
    throw corruptState(expectedContentRef);
  }
  const state = parsed as unknown as ProjectContentStateV1;
  validateCollectiveContentScope(state.collectiveScope, state);
  validateVideoProjectScope(state.projectScope, state.contentRef, state.mediaType, state.publicationScope);
  validateVideoProjectMediaScope(state.projectMediaScope, state);
  if (state.projectMediaScope && state.currentOwnerRevision !== 1) throw corruptState(expectedContentRef);
  validateCompleteRevisionChain(state);
  return state;
}

function validateCompleteRevisionChain(state: ProjectContentStateV1): void {
  const expectedLength = state.currentOwnerRevision;
  if (state.revisions.length !== expectedLength || state.receipts.length !== expectedLength) {
    throw corruptState(state.contentRef);
  }
  const operationIds = new Set<string>();
  const receiptIds = new Set<string>();
  for (let index = 0; index < expectedLength; index += 1) {
    const ownerRevision = index + 1;
    const revision = validateRevision(state, state.revisions[index], ownerRevision);
    const receipt = validateReceipt(state, state.receipts[index], revision, ownerRevision);
    if (operationIds.has(revision.operationId) || receiptIds.has(receipt.receiptId)) {
      throw corruptState(state.contentRef);
    }
    operationIds.add(revision.operationId);
    receiptIds.add(receipt.receiptId);
    validateOperation(state, revision.operationId, receipt.receiptId);
  }
  if (Object.keys(state.operations).length !== operationIds.size) throw corruptState(state.contentRef);
}

function validateRevision(
  state: ProjectContentStateV1,
  value: ProjectContentRevisionV1 | undefined,
  ownerRevision: number,
): ProjectContentRevisionV1 {
  if (!isRecord(value)) throw corruptState(state.contentRef);
  const expectedParent = ownerRevision === 1 ? null : ownerRevision - 1;
  if (
    value.contentRef !== state.contentRef ||
    value.ownerRevision !== ownerRevision ||
    value.parentRevision !== expectedParent ||
    value.mediaType !== state.mediaType ||
    !validDigest(value.blobDigest) ||
    !nonNegativeInteger(value.byteLength) ||
    !validIdentity(value.operationId) ||
    !validIdentity(value.committedAt) ||
    !validActor(value.committedBy)
  ) {
    throw corruptState(state.contentRef);
  }
  if (value.sourcePublication !== undefined && !isRecord(value.sourcePublication)) {
    throw corruptState(state.contentRef);
  }
  validateContentPublication(state.publicationScope, value.sourcePublication);
  return value as unknown as ProjectContentRevisionV1;
}

function validateReceipt(
  state: ProjectContentStateV1,
  value: ContentSettlementReceiptV1 | undefined,
  revision: ProjectContentRevisionV1,
  ownerRevision: number,
): ContentSettlementReceiptV1 {
  if (!isRecord(value)) throw corruptState(state.contentRef);
  if (
    !validIdentity(value.receiptId) ||
    value.contentRef !== state.contentRef ||
    value.previousOwnerRevision !== ownerRevision - 1 ||
    value.ownerRevision !== ownerRevision ||
    value.outboxSequence !== ownerRevision ||
    value.blobDigest !== revision.blobDigest ||
    value.operationId !== revision.operationId ||
    !sameActor(value.actor, revision.committedBy)
  ) {
    throw corruptState(state.contentRef);
  }
  validateContentOperationContext(value.operationContext, state.projectScope, state.collectiveScope);
  return value as unknown as ContentSettlementReceiptV1;
}

function validateOperation(state: ProjectContentStateV1, operationId: string, receiptId: string): void {
  const operation: unknown = state.operations[operationId];
  if (!isRecord(operation) || !validDigest(operation.fingerprint) || operation.receiptId !== receiptId) {
    throw corruptState(state.contentRef);
  }
}

function sameActor(left: unknown, right: unknown): boolean {
  return validActor(left) && validActor(right) && left.kind === right.kind && left.actorId === right.actorId;
}

function validActor(value: unknown): value is { kind: 'human' | 'cat'; actorId: string } {
  return isRecord(value) && (value.kind === 'human' || value.kind === 'cat') && validIdentity(value.actorId);
}

function validIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 2048 &&
    value.trim() === value &&
    !value.includes('\0')
  );
}

function validDigest(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
}

function positiveRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function invalidState(contentRef: string): Error {
  return new Error(`Invalid content owner state for ${contentRef}`);
}

function corruptState(contentRef: string): Error {
  return new Error(`Corrupt content owner state for ${contentRef}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
