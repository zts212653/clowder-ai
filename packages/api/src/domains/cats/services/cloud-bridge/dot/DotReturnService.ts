import { createCatId } from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../../stores/ports/MessageStore.js';
import type { IThreadStore } from '../../stores/ports/ThreadStore.js';
import { canViewMessage, getTimelineOrderTime, isTimelinePublished } from '../../stores/visibility.js';
import type { DotConnectionService } from './DotConnectionService.js';
import type { DotDispatchRecord, DotDispatchStore } from './DotDispatchStore.js';
import { DOT_CAT_ID, type DotConnectionState } from './dot-connection-state.js';
import { canDeliverDotSource } from './dot-reply-authority.js';

export class DotReturnService {
  private readonly replying = new Map<string, Promise<{ messageId: string; duplicate?: boolean }>>();
  constructor(
    private readonly options: {
      connection: DotConnectionService;
      dispatches: DotDispatchStore;
      messages: Pick<IMessageStore, 'getById' | 'getByThreadBefore'>;
      threads: Pick<IThreadStore, 'get'>;
      postReply: (input: {
        secret: string;
        eventId: string;
        threadId: string;
        sourceMessageId: string;
        content: string;
      }) => Promise<{ messageId: string }>;
      enabled?: () => Promise<boolean>;
    },
  ) {}

  async authorise(secret: string, eventId: string) {
    const state = await this.options.connection.authenticate(secret);
    const record = await this.options.dispatches.read(eventId);
    if (!record) throw new Error('dot_dispatch_unavailable');
    await this.validate(state, record);
    return { state, record };
  }

  async read(secret: string, eventId: string) {
    const { state } = await this.authorise(secret, eventId);
    return this.options.dispatches.update(eventId, async (record) => {
      if (!record) throw new Error('dot_dispatch_unavailable');
      const source = await this.validate(state, record);
      const context = (
        await this.options.messages.getByThreadBefore(
          record.threadId,
          getTimelineOrderTime(source),
          30,
          source.id,
          state.ownerUserId,
        )
      )
        .filter((message) => this.visible(message) && message.userId === state.ownerUserId)
        .map(this.projectMessage);
      await this.options.connection.recordEvidence(state, 'read');
      return {
        record: { ...record, sourceReadAt: Date.now() },
        result: {
          eventId,
          threadId: record.threadId,
          source: this.projectMessage(source),
          context,
          complete: false,
          scope: '原召唤之前最近 30 条可见消息，按原消息时间线游标限定；原召唤独立返回。',
          observedAt: Date.now(),
        },
      };
    });
  }

  async reply(secret: string, eventId: string, content: string) {
    await this.authorise(secret, eventId);
    const prior = this.replying.get(eventId) ?? Promise.resolve();
    const work = prior.catch(() => undefined).then(() => this.writeReply(secret, eventId, content));
    this.replying.set(eventId, work);
    try {
      return await work;
    } finally {
      if (this.replying.get(eventId) === work) this.replying.delete(eventId);
    }
  }

  private async writeReply(secret: string, eventId: string, content: string) {
    const { state } = await this.authorise(secret, eventId);
    // The callback writer also enforces the grant. Do not hold the dispatch lock
    // across it: its admission reads this same durable record.
    const record = await this.options.dispatches.read(eventId);
    if (!record?.sourceReadAt) throw new Error('dot_source_not_read');
    if (record.replyMessageId) return { messageId: record.replyMessageId, duplicate: true };
    if (record.expectedNonce && !content.includes(record.expectedNonce)) throw new Error('dot_test_nonce_mismatch');
    const posted = await this.options.postReply({
      secret,
      eventId,
      content,
      threadId: record.threadId,
      sourceMessageId: record.sourceMessageId,
    });
    await this.options.dispatches.update(eventId, async (latest) => {
      if (!latest) throw new Error('dot_dispatch_unavailable');
      return { record: { ...latest, replyMessageId: posted.messageId }, result: undefined };
    });
    await this.options.connection.recordEvidence(state, 'reply');
    return posted;
  }

  async admitReturn(input: {
    agentKeyId: string;
    userId: string;
    threadId: string;
    sourceMessageId: string;
    eventId: string;
    content: string;
  }) {
    const current = await this.options.connection.current();
    if (!current || current.agentKeyId !== input.agentKeyId || current.ownerUserId !== input.userId)
      throw new Error('dot_credential_rejected');
    const { record } = await this.authorise(current.credentialSecret, input.eventId);
    if (!record.sourceReadAt || record.threadId !== input.threadId || record.sourceMessageId !== input.sourceMessageId)
      throw new Error('dot_return_source_mismatch');
    if (!record.replyMessageId && record.expectedNonce && !input.content.includes(record.expectedNonce))
      throw new Error('dot_test_nonce_mismatch');
    return record.dispatchInvocationId;
  }

  private async validate(state: DotConnectionState, record: DotDispatchRecord) {
    const fresh = await this.options.connection.authenticate(state.credentialSecret);
    if (
      fresh.attemptId !== record.attemptId ||
      fresh.agentKeyId !== record.agentKeyId ||
      fresh.ownerUserId !== record.ownerUserId
    )
      throw new Error('dot_stale_dispatch');
    if (!record.connectionTest && this.options.enabled && !(await this.options.enabled()))
      throw new Error('dot_disabled');
    const thread = await this.options.threads.get(record.threadId);
    const source = await this.options.messages.getById(record.sourceMessageId);
    if (
      !thread ||
      thread.deletedAt ||
      thread.createdBy !== state.ownerUserId ||
      !source ||
      source.threadId !== thread.id ||
      source.userId !== state.ownerUserId ||
      !this.visible(source)
    )
      throw new Error('dot_source_unavailable');
    if (!(await canDeliverDotSource(fresh, source, this.options.messages)))
      throw new Error('dot_source_authority_revoked');
    return source;
  }

  private visible(message: StoredMessage) {
    return (
      !message.deletedAt &&
      !message.recall &&
      !message._tombstone &&
      isTimelinePublished(message) &&
      canViewMessage(message, { type: 'cat', catId: createCatId(DOT_CAT_ID) }) &&
      (message.visibility !== 'whisper' || !!message.revealedAt)
    );
  }

  private projectMessage(message: StoredMessage) {
    return {
      id: message.id,
      catId: message.catId,
      content: message.content,
      contentBlocks: message.contentBlocks ?? [],
      // Return the stored presentation payload without rewriting the original text
      // or exposing unrelated execution/tool metadata. Visibility is checked above.
      ...(message.extra?.rich ? { rich: message.extra.rich } : {}),
      ...(message.thinking ? { thinking: message.thinking } : {}),
      replyTo: message.replyTo ?? null,
      timestamp: message.timestamp,
    };
  }
}
