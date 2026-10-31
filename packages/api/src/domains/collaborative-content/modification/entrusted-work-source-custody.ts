import { type CustodyAdmissionRequestV1, custodyOfferV1Schema } from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../../cats/services/stores/ports/MessageStore.js';
import { deriveGrowingSourceMessageRevision } from '../../cats/services/stores/ports/MessageStore.js';
import {
  type EntrustedWorkAdmissionSourceContext,
  EntrustedWorkLifecycleError,
} from '../../growing/EntrustedWorkLifecycleService.js';

export async function assertDirectAdmissionSourceCustody(
  messageStore: Pick<IMessageStore, 'getById'>,
  actor: { readonly threadId: string; readonly userId: string },
  admission: CustodyAdmissionRequestV1,
): Promise<StoredMessage | null> {
  if (admission.basis === 'authorized_source') return null;
  if (admission.sourceRefs.length !== 1 || !admission.sourceRefs[0]?.startsWith('message:')) {
    throw new EntrustedWorkLifecycleError(
      'ENTRUSTED_WORK_SOURCE_CUSTODY_MISMATCH',
      'Conversation admission requires exactly one canonical Message source',
    );
  }
  const sourceMessageId = admission.sourceRefs[0].slice('message:'.length);
  const source = await messageStore.getById(sourceMessageId);
  if (!source) {
    throw new EntrustedWorkLifecycleError(
      'ENTRUSTED_WORK_SOURCE_NOT_FOUND',
      'The entrusted-work source Message does not exist',
    );
  }
  if (source.threadId !== actor.threadId || source.userId !== actor.userId) {
    throw new EntrustedWorkLifecycleError(
      'ENTRUSTED_WORK_SOURCE_SCOPE_MISMATCH',
      'The entrusted-work source Message is outside the authenticated owner Thread',
    );
  }
  if (
    source.catId !== null ||
    source.source !== undefined ||
    source.recall !== undefined ||
    source._tombstone ||
    source.deletedAt !== undefined ||
    source.custodyOfferParseFailure
  ) {
    throw new EntrustedWorkLifecycleError(
      'ENTRUSTED_WORK_SOURCE_CUSTODY_MISMATCH',
      'The entrusted-work source is not a current user-authored Message',
    );
  }

  const rawOffer = source.extra?.custodyOfferV1;
  if (admission.basis === 'explicit_entrustment') {
    if (rawOffer !== undefined) {
      throw new EntrustedWorkLifecycleError(
        'ENTRUSTED_WORK_SOURCE_CUSTODY_MISMATCH',
        'An existing source offer disposition cannot be bypassed as explicit entrustment',
      );
    }
    return source;
  }

  const offer = custodyOfferV1Schema.safeParse(rawOffer);
  const currentRevision = deriveGrowingSourceMessageRevision(source);
  if (
    !offer.success ||
    offer.data.disposition !== 'accepted' ||
    offer.data.offerId !== admission.offerId ||
    offer.data.sourceMessageRevision !== admission.sourceMessageRevision ||
    currentRevision !== admission.sourceMessageRevision ||
    offer.data.actorRef !== `user:${actor.userId}` ||
    offer.data.admission.idempotencyKey !== admission.idempotencyKey
  ) {
    throw new EntrustedWorkLifecycleError(
      'ENTRUSTED_WORK_SOURCE_CUSTODY_MISMATCH',
      'Accepted-offer admission does not match current source custody',
    );
  }
  return source;
}

export function admissionSourceContext(source: StoredMessage | null): EntrustedWorkAdmissionSourceContext | undefined {
  if (!source) return undefined;
  return { sourceRef: `message:${source.id}`, content: source.content };
}
