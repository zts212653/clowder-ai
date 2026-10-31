import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';
import { type ContentModificationRecord, createCatId } from '@cat-cafe/shared';
import { CODEX_IMAGE_MIME_BY_EXTENSION } from '../../../cats/services/agents/providers/codex-image-scanner.js';
import type { PublishedGeneratedImage } from '../../../cats/services/agents/providers/generated-image-publication.js';
import { publishGeneratedImage } from '../../../cats/services/agents/providers/generated-image-publication.js';
import { collectAllThreadMessages } from '../../../cats/services/agents/routing/thread-artifacts-aggregator.js';
import type { IMessageStore, StoredMessage } from '../../../cats/services/stores/ports/MessageStore.js';
import { deriveGrowingSourceMessageRevision, isDelivered } from '../../../cats/services/stores/ports/MessageStore.js';
import type { ArtifactReviewReturnDispatcher } from '../../../growing/ArtifactReviewReturnDispatcher.js';
import { MediaPublicationBinding, publicationFacet, sameAudience } from './media-publication-binding.js';
import type { MediaPublicationReturnIntent } from './media-publication-return.js';

/** Repairs native output → persisted gallery → original return outbox; the existing poller owns scheduling. */
export class MediaPublicationContinuation {
  constructor(
    private readonly deps: {
      binding: MediaPublicationBinding;
      messages: IMessageStore;
      dispatcher: ArtifactReviewReturnDispatcher;
    },
  ) {}

  async recover(record: ContentModificationRecord): Promise<void> {
    const { binding, dispatcher } = this.deps;
    const frame = await binding.frame(record);
    if (!frame) return;
    const producer = await binding.producer(frame.record);
    if (!producer) return;
    const human = await binding.originalSource(frame.record, producer);
    if (!human) return;
    const outputs = await binding.deps.nativeImages.read(producer);
    if (!outputs.length) return;
    if (!(await binding.uniqueProducer(frame.record, producer))) {
      await this.reportAmbiguity(frame.record, producer.invocationId, outputs.length, true);
      return;
    }
    if (outputs.length !== 1) {
      await this.reportAmbiguity(frame.record, producer.invocationId, outputs.length);
      return;
    }
    const output = outputs[0]!;
    const existing = binding.deps.store.returns.publicationForRequest(record.requestId);
    if (existing) {
      if (existing.state === 'pending') await dispatcher.drain();
      return;
    }
    const mimeType = CODEX_IMAGE_MIME_BY_EXTENSION[extname(output.sourcePath).toLowerCase()];
    if (!mimeType) return;
    const image = await publishGeneratedImage({
      sourcePath: output.sourcePath,
      mimeType,
      publicationKey: `codex-${output.origin.sessionId}-${basename(output.sourcePath)}`,
      provider: 'codex',
      toolName: 'imagegen',
      uploadDir: binding.deps.uploadDir,
      nativeOrigin: output.origin,
    });
    const publication = await this.ensurePublication(frame.record, producer, image);
    const gallery = publication.extra?.rich?.blocks.find(
      (block) => block.kind === 'media_gallery' && block.items.some((item) => item.url === image.urlPath),
    );
    if (!gallery) throw new Error('Generated media publication has no unique original image');
    const publicationRevision = publicationFacet(publication, gallery.id);
    if (!publicationRevision) return;
    const intent: MediaPublicationReturnIntent = {
      kind: 'resume_media_publication',
      requestId: record.requestId,
      receiptRef: `content-publication-return:${createHash('sha256')
        .update(JSON.stringify([record.requestId, frame.round.number, output.origin]))
        .digest('hex')}`,
      state: 'pending',
      createdAt: new Date(publication.timestamp).toISOString(),
      ownerUserId: record.ownerUserId,
      threadId: record.payload.threadId,
      targetCatId: record.payload.targetCatId,
      taskId: frame.task.id,
      expectedTaskRevision: frame.task.entrustedWork!.revision,
      reviewId: frame.review.reviewId,
      reviewRevision: frame.review.revision,
      round: frame.round.number,
      contentRef: frame.review.contentRef,
      ownerRevision: frame.round.asset.ownerRevision,
      visibility: human.visibility === 'whisper' ? 'whisper' : 'public',
      ...(human.visibility === 'whisper' ? { whisperTo: human.whisperTo ?? [] } : {}),
      source: {
        kind: 'platform_publication',
        sourceMessageId: human.id,
        sourceMessageRevision: deriveGrowingSourceMessageRevision(human),
        requestReceiptRef: record.progress.review!.receiptRef,
        publicationMessageId: publication.id,
        publicationRevision,
        publicationItemId: gallery.id,
        artifactRef: image.urlPath,
        artifactRevision: String(publication.timestamp),
        nativeOrigin: output.origin,
      },
    };
    if (!(await binding.validate(intent))) return;
    binding.deps.store.registerPublicationReturn(intent, frame.record.revision);
    await dispatcher.drain();
  }

  private async ensurePublication(
    record: ContentModificationRecord,
    producer: NonNullable<Awaited<ReturnType<MediaPublicationBinding['producer']>>>,
    image: PublishedGeneratedImage,
  ): Promise<StoredMessage> {
    const messages = await this.producerMessages(record, producer.invocationId);
    const published = messages.filter((message) =>
      message.extra?.rich?.blocks.some(
        (block) => block.kind === 'media_gallery' && block.items.some((item) => item.url === image.urlPath),
      ),
    );
    // Native completion selects the bytes; aliases follow the existing artifact reader's message-store order.
    if (published[0]) return published[0];
    // If the producer saved post_message before its rich result, repair that original message.
    if (messages.length === 1) {
      const message = await this.deps.messages.augmentStreamMetadata(messages[0]!.id, {
        extra: { turnExecution: this.turnProjection(producer), rich: { v: 1, blocks: [image.richBlock] } },
      });
      if (!message) throw new Error('Native image message changed during recovery');
      return message;
    }
    const recovered = await this.deps.messages.appendIdempotent({
      userId: record.ownerUserId,
      from: { kind: 'system', service: 'media-publication' },
      threadId: record.payload.threadId,
      mentions: [],
      content: '原请求生成的图片',
      timestamp: producer.endedAt!,
      idempotencyKey: `native-image-publication:${producer.invocationId}:${image.richBlock.id}`,
      replyTo: record.progress.sourceMessageId,
      ...(record.progress.sourceVisibility?.visibility === 'whisper'
        ? {
            visibility: 'whisper',
            whisperTo: record.progress.sourceVisibility.whisperTo.map(createCatId),
          }
        : {}),
      source: {
        connector: 'content-review',
        label: '生成图片',
        icon: 'cat-cafe',
        meta: { kind: 'generated_media_publication' },
      },
      extra: { turnExecution: this.turnProjection(producer), rich: { v: 1, blocks: [image.richBlock] } },
    });
    return recovered.message;
  }

  private turnProjection(producer: NonNullable<Awaited<ReturnType<MediaPublicationBinding['producer']>>>) {
    return {
      invocationId: producer.invocationId,
      parentInvocationId: producer.parentInvocationId,
      executionKind: producer.executionKind,
    };
  }

  private async producerMessages(record: ContentModificationRecord, invocationId: string) {
    const items = await collectAllThreadMessages(this.deps.messages, record.payload.threadId, record.ownerUserId);
    return items.filter(
      (message) =>
        isDelivered(message) &&
        !message.recall &&
        !message.deletedAt &&
        !message._tombstone &&
        message.userId === record.ownerUserId &&
        message.threadId === record.payload.threadId &&
        (message.catId === record.payload.targetCatId ||
          (message.catId === null && message.source?.meta?.kind === 'generated_media_publication')) &&
        message.extra?.turnExecution?.invocationId === invocationId &&
        sameAudience(message, record.progress.sourceVisibility),
    );
  }

  private async reportAmbiguity(
    record: ContentModificationRecord,
    invocationId: string,
    count: number,
    multipleRequests = false,
  ) {
    await this.deps.messages.appendIdempotent({
      userId: record.ownerUserId,
      from: { kind: 'system', service: 'media-publication' },
      threadId: record.payload.threadId,
      mentions: [],
      timestamp: Date.now(),
      idempotencyKey: `native-image-ambiguity:${record.requestId}:${invocationId}`,
      replyTo: record.progress.sourceMessageId,
      content: multipleRequests
        ? '本次生成图对应多个原请求，无法自动确定应交回哪个作品；需要你明确选择。原请求与生成图保留。'
        : `本次生成了 ${count} 张图，无法自动选定交回的作品候选；需要你明确选择。原请求与生成图保留。`,
      source: {
        connector: 'content-review',
        label: '作品候选待选择',
        icon: 'cat-cafe',
        meta: { kind: 'generated_media_ambiguity', requestId: record.requestId },
      },
      ...(record.progress.sourceVisibility?.visibility === 'whisper'
        ? {
            visibility: 'whisper',
            whisperTo: record.progress.sourceVisibility.whisperTo.map(createCatId),
          }
        : {}),
    });
  }
}
