import { companionIdentitySnapshotV1Schema } from '@cat-cafe/shared';
import type {
  CompanionConversationBodyV2,
  CompanionConversationPageV2,
  CompanionConversationRowV2,
} from '@clowder-ai/plugin-contract-beta28';
import {
  companionDeliveryMatches,
  publicCompanionDeliveryReceiptSchema,
} from '../../../cats/services/stores/companion-submission-state.js';
import type { StoredMessage } from '../../../cats/services/stores/ports/MessageStore.js';
import { getTimelineOrderTime } from '../../../cats/services/stores/visibility.js';
import { CompanionBridgeError } from '../companion-owner-client.js';
import { companionAuthorName } from './companion-author-name.js';
import { CompanionHistoryReferences, type HistoryReference } from './companion-history-references.js';
import {
  type CompanionHistoryOptions,
  CompanionHistorySource,
  conversationBodyRevision,
  conversationChunk,
} from './companion-history-source.js';

export type { CompanionHistoryOptions } from './companion-history-source.js';

const READ_OPTIONS = { includeQueuedCatMessages: true, includeQueuedUserMessages: true } as const;
const stalePage = () => ({ kind: 'conversation', v: 2, status: 'stale' }) as const;
/** One reader per admitted Host; no renderer coordinates or parallel Message owner. */
export class CompanionConversationHistory {
  private readonly source: CompanionHistorySource;
  private readonly refs = new CompanionHistoryReferences();
  constructor(options: CompanionHistoryOptions) {
    this.source = new CompanionHistorySource(options);
  }
  close(): void {
    this.refs.clear();
  }

  async readPage(input: { before?: string; limit?: number } = {}): Promise<CompanionConversationPageV2> {
    const limit = input.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 32) throw new CompanionBridgeError('invalid_request');
    await this.source.options.assertCurrent();
    let anchor: Extract<HistoryReference, { kind: 'history' }> | undefined;
    if (input.before !== undefined) {
      const reference = this.refs.read(input.before, 'history');
      if (!reference || reference.kind !== 'history') return stalePage();
      anchor = reference;
    }
    const threadId = await this.source.scope(anchor?.threadId);
    if (anchor) {
      const original = await this.source.original(anchor.messageId, threadId);
      if (!original || original.deletedAt || original.recall || getTimelineOrderTime(original) !== anchor.time)
        return stalePage();
    }
    const title = await this.source.options.client.request(`/api/threads/${encodeURIComponent(threadId)}`);
    await this.source.scope(threadId);
    if (typeof title.title !== 'string') throw new CompanionBridgeError('unavailable');
    const eligible: StoredMessage[] = [];
    let cursor = anchor;
    let exhausted = false;
    for (let scanned = 0; scanned < 256 && eligible.length <= limit; scanned += 64) {
      const raw = cursor
        ? await this.source.options.messages.getByThreadBefore(
            threadId,
            cursor.time,
            64,
            cursor.messageId,
            this.source.options.ownerUserId,
            READ_OPTIONS,
          )
        : await this.source.options.messages.getByThread(threadId, 64, this.source.options.ownerUserId, READ_OPTIONS);
      await this.source.scope(threadId);
      for (const row of [...raw].reverse()) if (this.source.visible(row, threadId)) eligible.push(structuredClone(row));
      exhausted = raw.length < 64;
      const oldest = raw[0];
      if (oldest) cursor = { kind: 'history', threadId, messageId: oldest.id, time: getTimelineOrderTime(oldest) };
      if (exhausted || !oldest) break;
    }
    const messages: CompanionConversationRowV2[] = [];
    let remaining = 24_000;
    for (const row of eligible.slice(0, limit)) {
      if (remaining <= 0) break;
      const text = conversationChunk(row.content, 0, Math.min(16_000, remaining));
      if (row.content.length > 0 && text.length === 0) break;
      remaining -= text.length;
      const response = await this.source.response(row, threadId);
      const current = await this.source.original(row.id, threadId);
      if (
        !current ||
        !this.source.visible(current, threadId) ||
        current.content !== row.content ||
        JSON.stringify(current.lifecycle) !== JSON.stringify(row.lifecycle) ||
        JSON.stringify(current.extra?.liveCompanion) !== JSON.stringify(row.extra?.liveCompanion)
      )
        return stalePage();
      const identity = companionIdentitySnapshotV1Schema.safeParse(row.extra?.liveCompanion?.identity);
      const delivery = publicCompanionDeliveryReceiptSchema.safeParse(current.companionDeliveryReceipt);
      messages.unshift({
        id: row.id,
        role: row.catId ? 'assistant' : 'user',
        name: companionAuthorName(row.catId),
        text,
        ...response,
        ...(delivery.success && companionDeliveryMatches(current, delivery.data)
          ? {
              deliveryReceipt: {
                kind: 'delivery' as const,
                v: 2 as const,
                delivery: 'accepted' as const,
                messageId: current.id,
                clientMessageId: delivery.data.clientMessageId,
                callId: delivery.data.callId,
              },
            }
          : {}),
        ...(identity.success && identity.data.live.catId === row.catId ? { companionIdentity: identity.data } : {}),
        body: this.body(threadId, row, text.length),
      });
    }
    const last = messages[0];
    const lastSource = last ? eligible.find((row) => row.id === last.id) : undefined;
    const hasMoreOlder = eligible.length > messages.length || !exhausted;
    const older = lastSource
      ? { kind: 'history' as const, threadId, messageId: lastSource.id, time: getTimelineOrderTime(lastSource) }
      : cursor;
    if (hasMoreOlder && !older) throw new CompanionBridgeError('unavailable');
    await this.source.scope(threadId);
    return {
      kind: 'conversation',
      v: 2,
      status: 'available',
      threadTitle: title.title.slice(0, 256),
      messages,
      hasMoreOlder,
      olderCursor: hasMoreOlder && older ? this.refs.issue(older) : null,
    };
  }
  private body(threadId: string, message: StoredMessage, offset: number) {
    const revision = conversationBodyRevision(message.content);
    return offset >= message.content.length
      ? { revision, complete: true as const, continuation: null }
      : {
          revision,
          complete: false as const,
          continuation: this.refs.issue({
            kind: 'body',
            threadId,
            messageId: message.id,
            revision,
            offset,
          }),
        };
  }
  async readBody(continuation: string): Promise<CompanionConversationBodyV2> {
    await this.source.options.assertCurrent();
    const reference = this.refs.read(continuation, 'body');
    const stale = { kind: 'conversation-body', v: 2, status: 'stale' } as const;
    if (!reference || reference.kind !== 'body') return stale;
    const message = await this.source.original(reference.messageId, reference.threadId);
    if (!message) throw new CompanionBridgeError('unavailable');
    if (message.deletedAt || message.recall || message._tombstone)
      return { kind: 'conversation-body', v: 2, status: 'withdrawn' };
    if (!this.source.visible(message, reference.threadId)) throw new CompanionBridgeError('permission_required');
    if (conversationBodyRevision(message.content) !== reference.revision) return stale;
    const snapshot = structuredClone(message);
    const text = conversationChunk(snapshot.content, reference.offset, 16_000);
    const current = await this.source.original(reference.messageId, reference.threadId);
    if (!current) throw new CompanionBridgeError('unavailable');
    if (current.deletedAt || current.recall || current._tombstone)
      return { kind: 'conversation-body', v: 2, status: 'withdrawn' };
    if (!this.source.visible(current, reference.threadId)) throw new CompanionBridgeError('permission_required');
    if (conversationBodyRevision(current.content) !== reference.revision) return stale;
    return {
      kind: 'conversation-body',
      v: 2,
      status: 'available',
      messageId: snapshot.id,
      text,
      body: this.body(reference.threadId, snapshot, reference.offset + text.length),
    };
  }
}
