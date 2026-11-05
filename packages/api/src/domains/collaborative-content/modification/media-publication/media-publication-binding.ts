import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { ContentModificationRecord, RespondWithMediaVersion, TurnExecutionRecord } from '@cat-cafe/shared';
import { MAX_IMAGE_FILE_SIZE } from '../../../../utils/image-storage.js';
import type { CodexNativeImageEvidenceReader } from '../../../cats/services/agents/providers/CodexNativeImageEvidenceReader.js';
import { CODEX_IMAGE_MIME_BY_EXTENSION } from '../../../cats/services/agents/providers/codex-image-scanner.js';
import { generatedImagePublicationLocation } from '../../../cats/services/agents/providers/generated-image-publication.js';
import {
  deriveGrowingSourceMessageRevision,
  type IMessageStore,
  isDelivered,
  type StoredMessage,
} from '../../../cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../../../cats/services/stores/ports/TaskStore.js';
import type { TurnExecutionSourceReadPort } from '../../../cats/services/stores/ports/TurnExecutionStore.js';
import type { PublishedMediaService } from '../../../video-studio/content-owner/published-media-service.js';
import { currentReviewModification } from '../../artifact-review/modification-request-reference.js';
import { reviewAuthorityState } from '../../artifact-review/review-authority.js';
import type { ArtifactReviewStore } from '../../artifact-review/store.js';
import { sameAudience, witnessedPublicationCaller } from './media-publication-caller.js';
import type { MediaPublicationReturnIntent } from './media-publication-return.js';
import { readModificationSourceExecution } from './source-execution.js';

export { sameAudience } from './media-publication-caller.js';

import { hasUniqueMediaProducerRequest, isBoundMediaModificationReturn } from '../bindings/media-return-binding.js';
import { assertRecoveryResponse } from '../publication-recovery-registration.js';
import { assertModificationSourceAuthority } from '../request-authority.js';

export class MediaPublicationBinding {
  constructor(
    readonly deps: {
      store: ArtifactReviewStore;
      messages: Pick<IMessageStore, 'getById' | 'getByIdempotencyKey'>;
      tasks: Pick<ITaskStore, 'get'>;
      turns?: TurnExecutionSourceReadPort;
      nativeImages: CodexNativeImageEvidenceReader;
      uploadDir: string;
      media: Pick<PublishedMediaService, 'currentRevision'>;
    },
  ) {}

  async frame(record: ContentModificationRecord, pendingOperationId?: string) {
    const current = this.deps.store.requests.get(record.requestId, record.ownerUserId);
    const reference = current?.progress.review;
    const taskReference = current?.progress.task;
    const prepared = current?.progress.prepared;
    if (!current || current.control || !reference || !taskReference || prepared?.kind !== 'media') return;
    const review = this.deps.store.get(reference.reviewId);
    const task = await this.deps.tasks.get(taskReference.taskId);
    const round = review?.rounds.at(-1);
    if (
      !review ||
      !task ||
      !round ||
      task.userId !== current.ownerUserId ||
      task.threadId !== current.payload.threadId ||
      task.ownerCatId !== current.payload.targetCatId ||
      review.task.ownerUserId !== current.ownerUserId ||
      review.task.threadId !== current.payload.threadId ||
      review.task.taskId !== task.id ||
      review.contentRef !== prepared.contentRef ||
      round.number !== reference.round ||
      round.asset.ownerRevision !== prepared.ownerRevision ||
      round.decision?.receiptRef !== reference.receiptRef ||
      reviewAuthorityState(review, task, round.asset.ownerRevision) !== 'current' ||
      currentReviewModification(this.deps.store, review)?.requestId !== current.requestId ||
      (this.deps.store.pendingVersion(review.reviewId) &&
        this.deps.store.pendingVersion(review.reviewId)?.input.operationId !== pendingOperationId)
    )
      return;
    const revision = await this.deps.media.currentRevision(review.contentRef, {
      userId: current.ownerUserId,
      actor: { kind: 'human', actorId: current.ownerUserId },
    });
    if (revision !== round.asset.ownerRevision) return;
    return { record: current, review, round, task };
  }

  async producer(record: ContentModificationRecord): Promise<TurnExecutionRecord | undefined> {
    const receiptRef = record.progress.review?.receiptRef;
    if (
      !receiptRef ||
      !this.deps.turns ||
      !isBoundMediaModificationReturn(this.deps.store, record, this.deps.store.returns.get(receiptRef))
    )
      return;
    const key = `f309-return:${createHash('sha256').update(receiptRef).digest('hex')}`;
    const carrier = await this.deps.messages.getByIdempotencyKey(record.ownerUserId, record.payload.threadId, key);
    if (
      !carrier ||
      carrier.userId !== record.ownerUserId ||
      carrier.threadId !== record.payload.threadId ||
      carrier.source?.connector !== 'content-review' ||
      !carrier.mentions.includes(record.payload.targetCatId as (typeof carrier.mentions)[number])
    )
      return;
    const child = await readModificationSourceExecution(
      this.deps.messages,
      this.deps.turns,
      carrier,
      record.payload.targetCatId,
    );
    if (
      !child ||
      child.status === 'running' ||
      child.status === 'canceled' ||
      child.userId !== record.ownerUserId ||
      child.threadId !== record.payload.threadId ||
      child.catId !== record.payload.targetCatId ||
      ![carrier.id, record.progress.sourceMessageId].some(
        (id) => id && (child.causal?.triggerMessageId === id || child.causal?.coveredMessageIds?.includes(id)),
      )
    )
      return;
    return child;
  }

  async originalSource(
    record: ContentModificationRecord,
    producer: TurnExecutionRecord,
  ): Promise<StoredMessage | undefined> {
    const source = record.progress.sourceMessageId
      ? await this.deps.messages.getById(record.progress.sourceMessageId)
      : null;
    if (
      !source ||
      source.catId !== null ||
      source.source ||
      source.userId !== record.ownerUserId ||
      source.threadId !== record.payload.threadId ||
      source.recall ||
      source._tombstone ||
      source.deletedAt ||
      source.extra?.custodyOfferV1 ||
      source.custodyOfferParseFailure
    )
      return;
    if (record.progress.sourceKind !== 'human_message') {
      await assertModificationSourceAuthority(this.deps.messages, record);
      return source;
    }
    if (
      deriveGrowingSourceMessageRevision(source) !== record.progress.sourceMessageRevision ||
      !source.mentions.includes(record.payload.targetCatId as (typeof source.mentions)[number]) ||
      !sameAudience(source, record.progress.sourceVisibility)
    )
      return;
    if (!isDelivered(source)) return;
    return source;
  }

  async validate(
    intent: MediaPublicationReturnIntent,
    response: RespondWithMediaVersion | undefined = intent.recovery?.response,
  ) {
    const frame = await this.acceptedFrame(intent, response);
    const record = frame?.record;
    if (
      !frame ||
      frame.review.revision !== intent.reviewRevision ||
      frame.task.entrustedWork?.revision !== intent.expectedTaskRevision ||
      frame.review.reviewId !== intent.reviewId ||
      frame.round.number !== intent.round ||
      frame.review.contentRef !== intent.contentRef ||
      frame.round.asset.ownerRevision !== intent.ownerRevision ||
      record?.payload.targetCatId !== intent.targetCatId ||
      record.payload.threadId !== intent.threadId ||
      record.progress.review?.receiptRef !== intent.source.requestReceiptRef
    )
      return;
    const producer = await this.producer(frame.record);
    if (!producer || producer.invocationId !== intent.source.nativeOrigin.invocationId) return;
    if (!(await this.uniqueProducer(frame.record, producer))) return;
    const source = await this.originalSource(frame.record, producer);
    if (
      !source ||
      source.id !== intent.source.sourceMessageId ||
      deriveGrowingSourceMessageRevision(source) !== intent.source.sourceMessageRevision
    )
      return;
    const outputs = await this.deps.nativeImages.read(producer);
    if (outputs.length !== 1 || !isDeepStrictEqual(outputs[0]?.origin, intent.source.nativeOrigin)) return;
    const output = outputs[0]!;
    const mime = CODEX_IMAGE_MIME_BY_EXTENSION[extname(output.sourcePath).toLowerCase()];
    if (!mime) return;
    const location = generatedImagePublicationLocation(
      `codex-${output.origin.sessionId}-${basename(output.sourcePath)}`,
      mime,
      this.deps.uploadDir,
    );
    if (location.urlPath !== intent.source.artifactRef) return;
    try {
      if (
        (await stat(location.absPath)).size > MAX_IMAGE_FILE_SIZE ||
        `sha256:${createHash('sha256')
          .update(await readFile(location.absPath))
          .digest('hex')}` !== output.origin.blobDigest
      )
        return;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
      throw error;
    }
    const publication = await this.deps.messages.getById(intent.source.publicationMessageId);
    if (!publication || !publicationMatches(publication, intent, frame.record)) return;
    return { ...frame, producer, source, publication };
  }

  private async acceptedFrame(intent: MediaPublicationReturnIntent, response?: RespondWithMediaVersion) {
    const selected = this.deps.store.returns.publicationForRequest(intent.requestId);
    if (selected && selected.receiptRef !== intent.receiptRef) return;
    const record = this.deps.store.requests.get(intent.requestId, intent.ownerUserId);
    const pending = this.deps.store.pendingVersion(intent.reviewId);
    if (pending) {
      if (!response) return;
      assertRecoveryResponse(this.deps.store, intent, response);
    }
    return record ? this.frame(record, pending ? response?.operationId : undefined) : undefined;
  }

  uniqueProducer(record: ContentModificationRecord, child: TurnExecutionRecord) {
    return hasUniqueMediaProducerRequest(
      {
        requests: this.deps.store.requests,
        messages: this.deps.messages,
        producer: (candidate) => this.producer(candidate),
      },
      record,
      child,
    );
  }

  async currentCaller(
    intent: MediaPublicationReturnIntent,
    invocationId: string | undefined,
    response?: RespondWithMediaVersion,
  ) {
    if (!invocationId || !(await this.validate(intent, response))) return false;
    return (await witnessedPublicationCaller(this.deps, intent, invocationId))?.status === 'running';
  }

  /** Project a historical accepted result through the same original-Human and return-consumer witnesses.
   * Round advancement and the consumer ending do not revoke a committed receipt or authorize another response.
   */
  async receiptSource(record: ContentModificationRecord) {
    const intent = this.deps.store.returns.publicationForRequest(record.requestId);
    if (
      !intent ||
      intent.ownerUserId !== record.ownerUserId ||
      intent.threadId !== record.payload.threadId ||
      intent.targetCatId !== record.payload.targetCatId ||
      intent.taskId !== record.progress.task?.taskId ||
      intent.source.requestReceiptRef !== record.progress.review?.receiptRef
    )
      return;
    const producer = await this.producer(record);
    if (!producer || producer.invocationId !== intent.source.nativeOrigin.invocationId) return;
    const source = await this.originalSource(record, producer);
    if (
      !source ||
      source.id !== intent.source.sourceMessageId ||
      deriveGrowingSourceMessageRevision(source) !== intent.source.sourceMessageRevision ||
      !(await witnessedPublicationCaller(this.deps, intent))
    )
      return;
    return source;
  }
}

export function publicationFacet(message: StoredMessage, itemId: string) {
  const block = message.extra?.rich?.blocks.find((item) => item.id === itemId);
  return block
    ? `sha256:${createHash('sha256')
        .update(
          JSON.stringify([
            message.id,
            message.userId,
            message.threadId,
            message.catId,
            message.extra?.turnExecution,
            message.visibility ?? 'public',
            [...(message.whisperTo ?? [])].sort(),
            block,
          ]),
        )
        .digest('hex')}`
    : undefined;
}

export function publicationMatches(
  message: StoredMessage,
  intent: MediaPublicationReturnIntent,
  record: ContentModificationRecord,
) {
  const block = message.extra?.rich?.blocks.find((item) => item.id === intent.source.publicationItemId);
  return (
    !message.recall &&
    !message.deletedAt &&
    !message._tombstone &&
    isDelivered(message) &&
    message.userId === record.ownerUserId &&
    message.threadId === record.payload.threadId &&
    (message.catId === record.payload.targetCatId ||
      (message.catId === null && message.source?.meta?.kind === 'generated_media_publication')) &&
    message.extra?.turnExecution?.invocationId === intent.source.nativeOrigin.invocationId &&
    sameAudience(message, record.progress.sourceVisibility) &&
    publicationFacet(message, intent.source.publicationItemId) === intent.source.publicationRevision &&
    String(message.timestamp) === intent.source.artifactRevision &&
    block?.kind === 'media_gallery' &&
    block.items.some((item) => item.url === intent.source.artifactRef)
  );
}
