import type { IInvocationRecordStore } from '../cats/services/stores/ports/InvocationRecordStore.js';
import type { IMessageStore, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import { LocalReviewCarrierEvidenceResolver } from './LocalReviewCarrierEvidenceResolver.js';

export const LOCAL_REVIEW_VERDICTS = ['approved', 'changes_requested', 'commented'] as const;
export type LocalReviewVerdict = (typeof LOCAL_REVIEW_VERDICTS)[number];

export type LocalReviewEvidenceResolution =
  | { status: 'verified'; evidenceRef: string }
  | { status: 'mismatch' | 'insufficient'; reason: string };

export interface LocalReviewEvidenceInput {
  evidenceRef: string;
  leaseId: string;
  subjectRef: string;
  headSha: string;
  generation: number;
  reviewerCatId: string;
  holderThreadId: string;
  predecessorCatId?: string;
  predecessorThreadId?: string;
  tenantScope: string;
}

export interface LocalReviewEvidenceProvider {
  resolve(input: LocalReviewEvidenceInput): Promise<LocalReviewEvidenceResolution>;
  resolveRecovery(input: LocalReviewEvidenceInput): Promise<LocalReviewEvidenceResolution>;
}

interface ParsedLocalReviewEvidenceRef {
  messageId: string;
  generation: number;
  verdict: LocalReviewVerdict;
}

const LOCAL_REVIEW_EVIDENCE_PATTERN = /^local-review:([^:\s]+):g([1-9]\d*):(approved|changes_requested|commented)$/;
export const LOCAL_REVIEW_MESSAGE_ID_PATTERN = /^[^:\s]+$/;

export function localReviewEvidenceRef(input: {
  messageId: string;
  generation: number;
  verdict: LocalReviewVerdict;
}): string {
  if (!LOCAL_REVIEW_MESSAGE_ID_PATTERN.test(input.messageId)) {
    throw new Error('local review messageId is not canonical');
  }
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
    throw new Error('local review generation must be a positive integer');
  }
  return `local-review:${input.messageId}:g${input.generation}:${input.verdict}`;
}

export function parseLocalReviewEvidenceRef(value: string): ParsedLocalReviewEvidenceRef | null {
  const match = LOCAL_REVIEW_EVIDENCE_PATTERN.exec(value);
  if (!match) return null;
  const [, messageId, generationText, verdict] = match;
  const generation = Number(generationText);
  if (!messageId || !Number.isSafeInteger(generation) || generation < 1) return null;
  return { messageId, generation, verdict: verdict as LocalReviewVerdict };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function routesToPredecessor(message: StoredMessage, predecessorCatId: string): boolean {
  if (message.extra?.targetCats?.includes(predecessorCatId)) return true;
  return new RegExp(`(?:^|\\n)@${escapeRegex(predecessorCatId)}(?:\\s|$)`, 'u').test(message.content);
}

function containsExactHead(content: string, headSha: string): boolean {
  return new RegExp(`(?:^|[^0-9a-f])${escapeRegex(headSha)}(?:[^0-9a-f]|$)`, 'i').test(content);
}

function containsSubject(content: string, subjectRef: string): boolean {
  const match = /^pr:([^/]+)\/([^#]+)#([1-9]\d*)$/.exec(subjectRef);
  if (!match) return false;
  const [, owner, repo, number] = match;
  if (!owner || !repo || !number) return false;
  const anchors = [
    subjectRef,
    `${owner}/${repo}#${number}`,
    `${repo} #${number}`,
    `github.com/${owner}/${repo}/pull/${number}`,
  ];
  return anchors.some((anchor) =>
    new RegExp(`(?:^|[^\\p{L}\\p{N}_.-])${escapeRegex(anchor)}(?![\\p{L}\\p{N}_])`, 'iu').test(content),
  );
}

function containsLegacyRecoverySubject(content: string, subjectRef: string): boolean {
  const match = /^pr:([^/]+)\/([^#]+)#([1-9]\d*)$/.exec(subjectRef);
  if (!match) return false;
  const number = match[3];
  if (!number) return false;
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_.-])PR #${escapeRegex(number)}(?=\\s|$)`, 'iu').test(content);
}

function containsVerdict(content: string, verdict: LocalReviewVerdict): boolean {
  const token =
    verdict === 'approved'
      ? 'APPROVE(?:D)?'
      : verdict === 'changes_requested'
        ? '(?:REQUEST_CHANGES|CHANGES_REQUESTED)'
        : 'COMMENT(?:ED)?';
  return new RegExp(`(?:^|\\n)${token}(?:\\s|$|[-—:])`, 'i').test(content);
}

function containsLegacyRecoveryVerdict(content: string, verdict: LocalReviewVerdict): boolean {
  if (verdict !== 'changes_requested') return false;
  return new RegExp('(?:^|\\n)\\*{0,2}Verdict:\\s*\\*{0,2}BLOCK(?=\\s|$)', 'i').test(content);
}

function verifyPersistedReviewMessage(
  message: StoredMessage,
  input: LocalReviewEvidenceInput,
  predecessorCatId: string,
  verdict: LocalReviewVerdict,
  grammar: 'canonical' | 'historical_recovery',
): LocalReviewEvidenceResolution {
  if (message.threadId !== input.predecessorThreadId) {
    return { status: 'mismatch', reason: 'local review verdict was not returned to the predecessor thread' };
  }
  if (!routesToPredecessor(message, predecessorCatId)) {
    return { status: 'mismatch', reason: 'local review verdict does not target the predecessor cat' };
  }
  if (
    input.holderThreadId !== input.predecessorThreadId &&
    message.extra?.crossPost?.sourceThreadId !== input.holderThreadId
  ) {
    return { status: 'mismatch', reason: 'local review cross-post does not originate from the holder thread' };
  }
  if (!containsExactHead(message.content, input.headSha)) {
    return { status: 'mismatch', reason: 'local review verdict does not bind the exact HEAD' };
  }
  const subjectMatches =
    containsSubject(message.content, input.subjectRef) ||
    (grammar === 'historical_recovery' && containsLegacyRecoverySubject(message.content, input.subjectRef));
  if (!subjectMatches) {
    return { status: 'mismatch', reason: 'local review verdict does not bind the action subject' };
  }
  const verdictMatches =
    containsVerdict(message.content, verdict) ||
    (grammar === 'historical_recovery' && containsLegacyRecoveryVerdict(message.content, verdict));
  if (!verdictMatches) {
    return { status: 'mismatch', reason: 'local review message does not contain the declared verdict' };
  }
  return { status: 'verified', evidenceRef: input.evidenceRef };
}

/**
 * Re-resolves a local review verdict from the canonical message store. The
 * evidence ref is only a locator; every lease-route and verdict claim is
 * checked again against persisted message truth.
 */
export class MessageStoreLocalReviewEvidenceProvider implements LocalReviewEvidenceProvider {
  private readonly carrierResolver: LocalReviewCarrierEvidenceResolver;

  constructor(
    private readonly messageStore: Pick<IMessageStore, 'getById'>,
    invocationRecordStore: Pick<IInvocationRecordStore, 'get'>,
  ) {
    this.carrierResolver = new LocalReviewCarrierEvidenceResolver(invocationRecordStore);
  }

  private async resolvePersistedVerdict(
    input: LocalReviewEvidenceInput,
    carrierMode: 'required' | 'carrierless_recovery',
  ): Promise<LocalReviewEvidenceResolution> {
    const parsed = parseLocalReviewEvidenceRef(input.evidenceRef);
    if (!parsed) return { status: 'mismatch', reason: 'local review evidence ref is malformed' };
    if (parsed.generation !== input.generation) {
      return { status: 'mismatch', reason: 'local review evidence generation does not match lease' };
    }
    if (!input.predecessorCatId || !input.predecessorThreadId) {
      return { status: 'insufficient', reason: 'local review lease has no structured predecessor route' };
    }

    const message = await this.messageStore.getById(parsed.messageId);
    if (!message) return { status: 'insufficient', reason: 'local review verdict message is unavailable' };
    if (message.userId !== input.tenantScope) {
      return { status: 'mismatch', reason: 'local review verdict tenant does not match lease' };
    }
    if (message.catId !== input.reviewerCatId) {
      return { status: 'mismatch', reason: 'local review verdict author is not the lease holder' };
    }
    const carrierFailure =
      carrierMode === 'required'
        ? await this.carrierResolver.resolveRequired(message, input)
        : await this.carrierResolver.resolveRecovery(message, input);
    if (carrierFailure) return carrierFailure;
    return verifyPersistedReviewMessage(
      message,
      input,
      input.predecessorCatId,
      parsed.verdict,
      carrierMode === 'carrierless_recovery' ? 'historical_recovery' : 'canonical',
    );
  }

  async resolve(input: LocalReviewEvidenceInput): Promise<LocalReviewEvidenceResolution> {
    return this.resolvePersistedVerdict(input, 'required');
  }

  async resolveRecovery(input: LocalReviewEvidenceInput): Promise<LocalReviewEvidenceResolution> {
    return this.resolvePersistedVerdict(input, 'carrierless_recovery');
  }
}
