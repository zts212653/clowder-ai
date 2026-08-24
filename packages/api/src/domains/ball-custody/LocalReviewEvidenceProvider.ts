import type { IInvocationRecordStore } from '../cats/services/stores/ports/InvocationRecordStore.js';
import type { IMessageStore, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import { LocalReviewCarrierEvidenceResolver } from './LocalReviewCarrierEvidenceResolver.js';

export const LOCAL_REVIEW_VERDICTS = ['approved', 'changes_requested', 'commented'] as const;
export type LocalReviewVerdict = (typeof LOCAL_REVIEW_VERDICTS)[number];

export type LocalReviewEvidenceResolution =
  | { status: 'verified'; evidenceRef: string; verdict: LocalReviewVerdict }
  | { status: 'mismatch' | 'insufficient'; reason: string };

export interface LocalReviewEvidenceInput {
  messageId: string;
  leaseId: string;
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

function routesToPredecessor(message: StoredMessage, predecessorCatId: string): boolean {
  if (message.extra?.targetCats?.includes(predecessorCatId)) return true;
  return message.mentions.some((catId) => catId === predecessorCatId);
}

function verifyPersistedReviewMessage(
  message: StoredMessage,
  input: LocalReviewEvidenceInput,
  predecessorCatId: string,
  verdict: LocalReviewVerdict,
  evidenceRef: string,
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
  return { status: 'verified', evidenceRef, verdict };
}

/**
 * Re-resolves a local review verdict from the canonical message store. The
 * message id is only a locator; typed verdict metadata plus every carrier and
 * lease-route dimension is checked again without parsing public prose.
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
    if (!input.predecessorCatId || !input.predecessorThreadId) {
      return { status: 'insufficient', reason: 'local review lease has no structured predecessor route' };
    }

    const message = await this.messageStore.getById(input.messageId);
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
    const verdict = message.extra?.localReviewVerdict?.verdict;
    if (!verdict || !LOCAL_REVIEW_VERDICTS.includes(verdict)) {
      return { status: 'insufficient', reason: 'local review message has no typed verdict fact' };
    }
    const evidenceRef = localReviewEvidenceRef({ messageId: message.id, generation: input.generation, verdict });
    return verifyPersistedReviewMessage(message, input, input.predecessorCatId, verdict, evidenceRef);
  }

  async resolve(input: LocalReviewEvidenceInput): Promise<LocalReviewEvidenceResolution> {
    return this.resolvePersistedVerdict(input, 'required');
  }

  async resolveRecovery(input: LocalReviewEvidenceInput): Promise<LocalReviewEvidenceResolution> {
    return this.resolvePersistedVerdict(input, 'carrierless_recovery');
  }
}
