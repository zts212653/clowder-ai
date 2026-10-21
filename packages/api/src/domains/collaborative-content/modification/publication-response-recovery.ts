import { createHash } from 'node:crypto';
import type { ArtifactReviewReturnDispatcher } from '../../growing/ArtifactReviewReturnDispatcher.js';
import type { MediaReviewPrincipal } from '../../video-studio/content-owner/published-media-access.js';
import type { PublishedMediaService } from '../../video-studio/content-owner/published-media-service.js';
import { ArtifactReviewError } from '../artifact-review/errors.js';
import { reviewVersionOperationId } from '../artifact-review/version-response-service.js';
import type { MediaPublicationBinding } from './media-publication/media-publication-binding.js';
import { witnessedPublicationCaller } from './media-publication/media-publication-caller.js';
import type { MediaPublicationReturnIntent } from './media-publication/media-publication-return.js';
import {
  publicationRecoveryCommandSchema,
  publicationRecoveryFingerprint,
  publicationResponseFingerprint,
} from './publication-recovery-contract.js';
import { assertRecoveryResponse } from './publication-recovery-registration.js';

/** Explicit direct Human authorization creates a new delivery generation, never a new business request. */
export class PublicationResponseRecoveryService {
  constructor(
    private readonly deps: {
      binding: MediaPublicationBinding;
      media: Pick<PublishedMediaService, 'operationReceipt'>;
      dispatcher: Pick<ArtifactReviewReturnDispatcher, 'drain'>;
    },
  ) {}

  async recover(requestId: string, raw: unknown, principal: MediaReviewPrincipal) {
    if (principal.actor.kind !== 'human' || principal.actor.actorId !== principal.userId)
      throw new ArtifactReviewError('human_required');
    const command = publicationRecoveryCommandSchema.parse(raw);
    const { binding, media, dispatcher } = this.deps;
    const { store } = binding.deps;
    const record = store.requests.get(requestId, principal.userId);
    if (!record) throw new ArtifactReviewError('not_found');
    const fingerprint = publicationRecoveryFingerprint(requestId, command);
    const replay = () => {
      const receipt = store.returns.publications.replay(principal.userId, command.operationId, fingerprint);
      return receipt ? (store.returns.get(receipt) as MediaPublicationReturnIntent) : undefined;
    };
    const existing = replay();
    if (existing) {
      if (existing.state === 'pending') await dispatcher.drain();
      return { intent: store.returns.get(existing.receiptRef), replayed: true };
    }
    const prior = store.returns.publicationForRequest(requestId);
    if (
      !prior ||
      prior.state !== 'queued' ||
      prior.receiptRef !== command.recoveryOfReceiptRef ||
      (prior.recovery?.generation ?? 0) !== command.expectedGeneration
    )
      throw new ArtifactReviewError('revision_conflict');
    if (record.control) throw new ArtifactReviewError('request_cancelled');
    if (record.revision !== command.expectedRequestRevision) throw new ArtifactReviewError('revision_conflict');
    assertRecoveryResponse(store, prior, command.response);
    const responseFingerprint = publicationResponseFingerprint(command.response);
    if (prior.recovery && prior.recovery.responseFingerprint !== responseFingerprint)
      throw new ArtifactReviewError('operation_reused');
    const caller = await witnessedPublicationCaller(binding.deps, prior, command.expectedPriorInvocationId, 'terminal');
    if (!caller || caller.status === 'running' || caller.status === 'canceled')
      throw new ArtifactReviewError('access_denied');
    if (!(await binding.validate(prior, command.response))) throw new ArtifactReviewError('publication_changed');
    if (
      await media.operationReceipt(
        prior.contentRef,
        reviewVersionOperationId(prior.reviewId, command.response.operationId),
        principal,
      )
    )
      throw new ArtifactReviewError('operation_reused');
    // Independent Message/Task owners are re-read after async native/receipt reads; the outbox CAS below is synchronous.
    const valid = await binding.validate(prior, command.response);
    const currentCaller = await witnessedPublicationCaller(
      binding.deps,
      prior,
      command.expectedPriorInvocationId,
      'terminal',
    );
    const concurrentReplay = replay();
    if (concurrentReplay) return { intent: concurrentReplay, replayed: true };
    if (!valid || !currentCaller || currentCaller.status === 'running' || currentCaller.status === 'canceled')
      throw new ArtifactReviewError('publication_changed');
    const { state: _state, messageId: _messageId, retirementReason: _reason, recovery: _recovery, ...original } = prior;
    const intent: MediaPublicationReturnIntent = {
      ...original,
      receiptRef: `content-publication-recovery:${createHash('sha256')
        .update(JSON.stringify([prior.ownerUserId, requestId, command.operationId]))
        .digest('hex')}`,
      state: 'pending',
      createdAt: new Date().toISOString(),
      recovery: {
        generation: command.expectedGeneration + 1,
        recoveryOfReceiptRef: prior.receiptRef,
        operationId: command.operationId,
        expectedPriorInvocationId: command.expectedPriorInvocationId,
        response: command.response,
        responseFingerprint,
      },
    };
    const accepted = store.registerPublicationRecovery(intent, command.expectedRequestRevision, fingerprint);
    await dispatcher.drain();
    return { intent: store.returns.get(accepted.intent.receiptRef), replayed: accepted.replayed };
  }
}
