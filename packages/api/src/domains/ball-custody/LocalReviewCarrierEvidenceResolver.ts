import type { IInvocationRecordStore, InvocationRecord } from '../cats/services/stores/ports/InvocationRecordStore.js';
import type { StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import type { LocalReviewEvidenceInput, LocalReviewEvidenceResolution } from './LocalReviewEvidenceProvider.js';

type CarrierFailure = LocalReviewEvidenceResolution | null;

export class LocalReviewCarrierEvidenceResolver {
  constructor(private readonly invocationRecordStore: Pick<IInvocationRecordStore, 'get'>) {}

  private carrierMatchesMessagePrincipal(
    carrier: Pick<InvocationRecord, 'threadId' | 'userId' | 'targetCats'>,
    input: LocalReviewEvidenceInput,
  ): boolean {
    return (
      carrier.threadId === input.holderThreadId &&
      carrier.userId === input.tenantScope &&
      carrier.targetCats.some((catId) => catId === input.reviewerCatId)
    );
  }

  async resolveRequired(message: StoredMessage, input: LocalReviewEvidenceInput): Promise<CarrierFailure> {
    const carrierInvocationId = message.extra?.stream?.invocationId;
    if (!carrierInvocationId) {
      return { status: 'insufficient', reason: 'local review verdict message has no invocation carrier provenance' };
    }
    const carrier = await this.invocationRecordStore.get(carrierInvocationId);
    if (!carrier) {
      return { status: 'insufficient', reason: 'local review verdict invocation carrier is unavailable' };
    }
    if (!this.carrierMatchesMessagePrincipal(carrier, input)) {
      return {
        status: 'mismatch',
        reason: 'local review verdict invocation carrier is outside the message principal scope',
      };
    }
    if (
      carrier.actionLeaseCarrier.kind !== 'action_successor' ||
      carrier.actionLeaseCarrier.leaseId !== input.leaseId ||
      carrier.actionLeaseCarrier.generation !== input.generation
    ) {
      return {
        status: 'mismatch',
        reason: 'local review verdict message does not carry the current action lease generation',
      };
    }
    return null;
  }

  async resolveRecovery(message: StoredMessage, input: LocalReviewEvidenceInput): Promise<CarrierFailure> {
    const carrierInvocationId = message.extra?.stream?.invocationId;
    if (!carrierInvocationId) {
      return { status: 'insufficient', reason: 'local review verdict message has no invocation provenance' };
    }
    const carrier = await this.invocationRecordStore.get(carrierInvocationId);
    if (!carrier) {
      return { status: 'insufficient', reason: 'local review verdict invocation provenance is unavailable' };
    }
    if (!this.carrierMatchesMessagePrincipal(carrier, input)) {
      return {
        status: 'mismatch',
        reason: 'local review verdict invocation is outside the message principal scope',
      };
    }
    if (
      carrier.actionLeaseCarrier.kind === 'action_successor' &&
      (carrier.actionLeaseCarrier.leaseId !== input.leaseId ||
        carrier.actionLeaseCarrier.generation !== input.generation)
    ) {
      return {
        status: 'mismatch',
        reason: 'local review verdict message carries a conflicting action lease generation',
      };
    }
    return null;
  }
}
