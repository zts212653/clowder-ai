import type {
  MessageSearchAnswerAttachmentRequest,
  MessageSearchAnswerView,
  MessageSearchInput,
} from '@cat-cafe/shared';
import {
  matchesMessageSearchAnswer,
  messageSearchAnswerBlock,
} from '../cats/services/stores/message-search-answer-binding.js';
import type { IMessageStore, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../cats/services/stores/ports/ThreadStore.js';
import {
  type AnswerProducer,
  answerDigest,
  answerProducerKey,
  type MessageSearchAnswerPublication,
  MessageSearchAnswerPublicationStore,
} from './MessageSearchAnswerPublicationStore.js';
import { type MessageSearchPrincipal, type MessageSearchService } from './MessageSearchService.js';
import {
  answerBinding,
  assertAnswerDestination,
  isAnswerMessageReadable,
  readMessageSearchAnswer,
} from './message-search-answer-admission.js';
import { boundMessageSearchResponse } from './message-search-budget.js';

export interface PrepareMessageSearchAnswer {
  operationId: string;
  input: MessageSearchInput;
  principal: MessageSearchPrincipal;
  producer: AnswerProducer;
  targetThreadId: string;
  acceptedUseRef?: string;
}
type Execution = {
  signal?: AbortSignal;
  deadlineAt?: number;
  onTrace?: (trace: Record<string, unknown>) => void;
  authorizeAcceptedUse?: () => Promise<void>;
};
type PublicationMessages = Pick<IMessageStore, 'getById' | 'getByIdempotencyKey' | 'attachMessageSearchAnswer'>;

/** Memory owns the sole response; the original message store owns the immutable binding. */
export class MessageSearchAnswerPublicationService {
  constructor(
    readonly store: MessageSearchAnswerPublicationStore,
    private readonly search: MessageSearchService,
    private readonly messages: PublicationMessages,
    private readonly threads: Pick<IThreadStore, 'get' | 'list'>,
  ) {}

  private owns(
    record: MessageSearchAnswerPublication,
    userId: string,
    producer: AnswerProducer,
    threadId: string,
  ): boolean {
    return (
      record.owner_user_id === userId &&
      record.producer_key === answerProducerKey(producer) &&
      record.target_thread_id === threadId
    );
  }
  async prepare(input: PrepareMessageSearchAnswer, execution: Execution = {}) {
    await assertAnswerDestination(this.threads, input.principal.userId, input.targetThreadId);
    const principal = { ...input.principal, publicReply: true };
    const requestDigest = answerDigest({
      input: input.input,
      targetThreadId: input.targetThreadId,
      acceptedUseRef: input.acceptedUseRef,
    });
    const claimed = await this.store.claim({
      ownerUserId: principal.userId,
      producer: input.producer,
      operationId: input.operationId,
      targetThreadId: input.targetThreadId,
      requestDigest,
    });
    const ref = claimed.record.publication_ref;
    if (claimed.record.request_digest !== requestDigest) throw new Error('ANSWER_OPERATION_CONFLICT');
    if (claimed.created) {
      try {
        await execution.authorizeAcceptedUse?.();
        const searched = await this.search.search(input.input, principal, execution);
        execution.signal?.throwIfAborted();
        await assertAnswerDestination(this.threads, principal.userId, input.targetThreadId);
        execution.signal?.throwIfAborted();
        // Reserve the fixed receipt envelope inside the original 24k transport budget.
        await this.store.complete(ref, boundMessageSearchResponse(searched, 23000));
      } catch (error) {
        await this.store.fail(ref);
        throw error;
      }
    }
    const record = this.store.get(ref)!;
    if (record.state !== 'prepared')
      return { status: record.state === 'searching' ? 'pending' : 'failed', publicationRef: ref };
    await this.recoverResponse(record);
    const actual = this.store.get(ref)!;
    const saved = this.store.response(actual);
    if (!saved) return { status: 'unavailable', publicationRef: ref };
    const message = actual.bound_message_id ? await this.messages.getById(actual.bound_message_id) : null;
    const published =
      !!message && !!answerBinding(actual) && matchesMessageSearchAnswer(message, answerBinding(actual)!);
    const view = await this.search.readAnswerSnapshot(saved, principal, execution.signal);
    if (saved.results.length && !view.response.results.length) return { status: 'unavailable', publicationRef: ref };
    return {
      status: published ? 'published' : 'prepared',
      publicationRef: ref,
      searchId: view.response.searchId,
      ...view,
    };
  }
  async preparePost(
    request: MessageSearchAnswerAttachmentRequest,
    userId: string,
    producer: AnswerProducer,
    threadId: string,
    existingMessageId?: string,
  ) {
    await assertAnswerDestination(this.threads, userId, threadId);
    const record = this.store.get(request.publicationRef);
    if (!record || record.owner_user_id !== userId || record.state !== 'prepared' || !this.store.response(record))
      return null;
    if (request.source) {
      const source = await this.read(request.source.messageId, request.source.blockId, {
        userId,
        viewer: { type: 'user' },
        publicReply: true,
      });
      if (source.status !== 'available' || source.publicationRef !== request.publicationRef) return null;
    } else if (
      !this.owns(record, userId, producer, threadId) ||
      (record.bound_message_id && record.bound_message_id !== existingMessageId)
    )
      return null;
    const existing = existingMessageId ? await this.messages.getById(existingMessageId) : null;
    const block = messageSearchAnswerBlock({
      v: 1,
      publicationRef: record.publication_ref,
      blockId: `search-answer-${record.publication_ref.slice(-32)}`,
      responseDigest: record.response_digest!,
    });
    if (
      existing &&
      !existing.extra?.rich?.blocks.some(
        (candidate) =>
          candidate.id === block.id &&
          candidate.kind === 'card' &&
          candidate.meta?.domain === 'message-search-answer' &&
          candidate.meta.publicationRef === record.publication_ref,
      )
    )
      return null;
    return block;
  }
  async publishPost(
    request: MessageSearchAnswerAttachmentRequest,
    messageId: string,
    producer: AnswerProducer,
    userId: string,
  ): Promise<StoredMessage | null> {
    const message = await this.messages.getById(messageId);
    if (
      !message ||
      !message.extra?.isExplicitPost ||
      message.from?.kind !== 'agent' ||
      message.from.catId !== producer.catId
    )
      return null;
    if (!(await this.preparePost(request, userId, producer, message.threadId, messageId))) return null;
    if (!request.source) return this.publish(request.publicationRef, messageId, producer, userId);
    const record = this.store.get(request.publicationRef)!;
    if (!record.bound_message_id) return null;
    return this.messages.attachMessageSearchAnswer(messageId, {
      ownerUserId: userId,
      threadId: message.threadId,
      catId: producer.catId,
      binding: { ...answerBinding(record)!, forwardedFromMessageId: record.bound_message_id },
    });
  }
  /** Called after the original successful message/R commit, never from generic rich input. */
  async publish(
    ref: string,
    messageId: string,
    producer: AnswerProducer,
    userId: string,
  ): Promise<StoredMessage | null> {
    const record = this.store.get(ref),
      message = await this.messages.getById(messageId);
    if (
      !record ||
      !message ||
      !this.owns(record, userId, producer, message.threadId) ||
      record.state !== 'prepared' ||
      message.from?.kind !== 'agent' ||
      message.from.catId !== producer.catId ||
      !isAnswerMessageReadable(message, userId, { type: 'user' })
    )
      return null;
    if (
      message.origin === 'stream' &&
      (message.lifecycle?.kind !== 'response' ||
        message.lifecycle.invocationId !== producer.id ||
        message.lifecycle.status !== 'completed')
    )
      return null;
    if (message.origin !== 'stream' && !message.extra?.isExplicitPost) return null;
    if (message.extra?.messageSearchAnswer && message.extra.messageSearchAnswer.publicationRef !== ref) return null;
    await assertAnswerDestination(this.threads, userId, message.threadId);
    const response = this.store.response(record);
    if (!response) return null;
    const view = await this.search.readAnswerSnapshot(response, {
      userId,
      viewer: { type: 'user' },
      publicReply: true,
    });
    if (response.results.length && !view.response.results.length) return null;
    const blockId = `search-answer-${record.publication_ref.slice(-32)}`;
    if (!(await this.store.claimBinding(ref, messageId, blockId))) return null;
    const claimed = this.store.get(ref)!;
    const attached = await this.messages.attachMessageSearchAnswer(messageId, {
      ownerUserId: userId,
      threadId: message.threadId,
      catId: producer.catId,
      binding: answerBinding(claimed)!,
    });
    if (attached && matchesMessageSearchAnswer(attached, answerBinding(claimed)!))
      await this.store.completeRecovery(claimed);
    return attached;
  }
  async publishResponse(message: StoredMessage, invocationId: string): Promise<StoredMessage> {
    const record = this.store.forInvocation(message.userId, message.catId ?? '', invocationId);
    if (!record || record.state !== 'prepared') return message;
    return (
      (await this.publish(
        record.publication_ref,
        message.id,
        { kind: 'invocation', id: invocationId, catId: message.catId! },
        message.userId,
      )) ?? message
    );
  }
  private async recoverResponse(record: MessageSearchAnswerPublication): Promise<void> {
    if (!record.invocation_id || record.state !== 'prepared') return;
    const message = record.bound_message_id
      ? await this.messages.getById(record.bound_message_id)
      : await this.messages.getByIdempotencyKey(
          record.owner_user_id,
          record.target_thread_id,
          `message-lifecycle-response:${record.invocation_id}`,
        );
    const bound = answerBinding(record);
    if (message && bound && matchesMessageSearchAnswer(message, bound)) {
      await this.store.completeRecovery(record);
      return;
    }
    if (message?.lifecycle?.kind === 'response' && message.lifecycle.status === 'completed')
      await this.publishResponse(message, record.invocation_id);
  }
  /** Reconcile only already committed original R coordinates; never rerun a search after restart. */
  async recoverPreparedResponses() {
    const pass = this.store.recoveryPass();
    let scanned = 0,
      deferred = 0;
    const deadline = Date.now() + 15000;
    for (;;) {
      const page = this.store.pendingResponses(pass);
      for (const record of page) {
        if (Date.now() >= deadline || scanned >= 1000) return { scanned, deferred, hasMore: true };
        scanned++;
        try {
          await this.recoverResponse(record);
        } catch {
          deferred++;
        }
        // Persist progress even for still-pending/failed attempts; the next boot starts with unseen rows.
        // A concurrent successful binding has set NULL and cannot be re-enqueued by this update.
        await this.store.deferRecovery(record.publication_ref, pass);
      }
      if (page.length < 100) return { scanned, deferred, hasMore: false };
    }
  }
  read(
    messageId: string,
    blockId: string,
    principal: MessageSearchPrincipal,
    signal?: AbortSignal,
  ): Promise<MessageSearchAnswerView> {
    return readMessageSearchAnswer(
      { store: this.store, search: this.search, messages: this.messages, threads: this.threads },
      messageId,
      blockId,
      principal,
      signal,
    );
  }
}
