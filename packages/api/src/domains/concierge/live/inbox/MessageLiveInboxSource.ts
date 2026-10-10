import type { InvocationQueue } from '../../../cats/services/agents/invocation/InvocationQueue.js';
import {
  type QueueLedgerEntry,
  queueEntryId,
} from '../../../cats/services/agents/invocation/queue-ledger/QueueLedger.js';
import { isFreshnessRoutableMessage } from '../../../cats/services/freshness/freshness-routable-message.js';
import type { IMessageStore, StoredMessage } from '../../../cats/services/stores/ports/MessageStore.js';
import { canViewMessage, getTimelineOrderTime } from '../../../cats/services/stores/visibility.js';
import type { LiveInboxReference, LiveInboxScope, LiveInboxSource } from './live-inbox-contract.js';

export interface MessageLiveInboxOptions {
  store: Pick<IMessageStore, 'getByThreadAfter' | 'getById'>;
  /** Canonical pending owner plus ordinary full-body selection. No receipt shadow writes. */
  queue?: Pick<InvocationQueue, 'getQueuedBodyMessagesForCat' | 'getDurableEntriesForMessages'>;
  /** Current Host scope/permission check; a stored message never grants permission to a new call. */
  authorize(scope: LiveInboxScope): Promise<boolean>;
  isSameCallExposure?(message: StoredMessage): boolean;
  /** True only with Host/F296 retained-context evidence. Unknown continuity must replay old reads. */
  retainsCurrentInvocationReads?(scope: LiveInboxScope): boolean;
}

export class LiveInboxAuthorityUnavailableError extends Error {
  constructor() {
    super('Live inbox authority unavailable');
    this.name = 'LiveInboxAuthorityUnavailableError';
  }
}

export class MessageLiveInboxSource implements LiveInboxSource {
  constructor(private readonly options: MessageLiveInboxOptions) {}
  async page(scope: LiveInboxScope, cursor: string | undefined, limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid Live inbox page size');
    await this.assertAuthorized(scope);
    // Raw owner timeline is needed for queued user metadata. No body escapes this projection;
    // actual exposure must still pass the existing exact-child full-read path.
    const messages = await this.options.store.getByThreadAfter(scope.threadId, cursor, limit, scope.userId, {
      includeQueuedCatMessages: true,
      includeQueuedUserMessages: true,
      unresolvedCursorPolicy: 'rescan',
    });
    const pending = await this.pending(
      scope,
      messages.map((message) => message.id),
    );
    const projected = await Promise.all(
      messages.map((message) => this.project(scope, message, pending.get(message.id) ?? [])),
    );
    await this.assertAuthorized(scope);
    return {
      items: projected.filter((item): item is LiveInboxReference => item !== null),
      // This is an ephemeral raw-timeline cursor, never a seen cursor. A lost anchor rescans,
      // and a process restart always reads canonical custody again from the beginning.
      nextCursor: messages.at(-1)?.id,
      hasMore: messages.length === limit,
    };
  }
  async read(scope: LiveInboxScope, messageId: string): Promise<LiveInboxReference | null> {
    await this.assertAuthorized(scope);
    const message = await this.options.store.getById(messageId);
    const pending = message ? await this.pending(scope, [messageId]) : new Map<string, QueueLedgerEntry[]>();
    const projected = message ? await this.project(scope, message, pending.get(messageId) ?? []) : null;
    await this.assertAuthorized(scope);
    return projected;
  }

  private async pending(
    scope: LiveInboxScope,
    messageIds: readonly string[],
  ): Promise<Map<string, QueueLedgerEntry[]>> {
    return this.options.queue?.getDurableEntriesForMessages(scope.threadId, messageIds) ?? new Map();
  }

  private async assertAuthorized(scope: LiveInboxScope): Promise<void> {
    if (!(await this.options.authorize(scope))) throw new LiveInboxAuthorityUnavailableError();
  }

  private async project(
    scope: LiveInboxScope,
    message: StoredMessage,
    entries: readonly QueueLedgerEntry[],
  ): Promise<LiveInboxReference | null> {
    if (
      message.userId !== scope.userId ||
      message.threadId !== scope.threadId ||
      message.deletedAt !== undefined ||
      message.recall ||
      message.deliveryStatus === 'canceled' ||
      !canViewMessage(message, { type: 'cat', catId: scope.catId }) ||
      !isFreshnessRoutableMessage(message) ||
      this.options.isSameCallExposure?.(message)
    )
      return null;
    const owned = entries.filter(
      (entry) =>
        entry.threadId === scope.threadId &&
        entry.owner.kind === 'user' &&
        entry.owner.userId === scope.userId &&
        entry.payload.messageId === message.id &&
        entry.targets.includes(scope.catId),
    );
    const refs = message.lifecycle?.dispatchRefs?.filter((ref) => ref.targetId === scope.catId) ?? [];
    // Ambiguous evidence never selects an owner. History delivery wins over a stale pending cache.
    if (owned.length > 1 || refs.length > 1 || (owned.length === 0 && refs.length === 0)) return null;
    const entry = owned[0];
    const ref = refs[0];
    const response = ref ? await this.options.store.getById(ref.statusMessageId) : null;
    const lifecycle = response?.lifecycle;
    const expectedEntryId = entry?.id ?? queueEntryId(message.id);
    const exactResponse = Boolean(
      response &&
        response.userId === scope.userId &&
        response.threadId === scope.threadId &&
        response.catId === scope.catId &&
        lifecycle?.kind === 'response' &&
        lifecycle.targetId === scope.catId &&
        lifecycle.inputMessageIds.includes(message.id) &&
        lifecycle.inputEntryIds.includes(expectedEntryId),
    );
    const readByInvocationIds = exactResponse && lifecycle?.kind === 'response' ? [lifecycle.invocationId] : [];
    const exactDeliveryFailure = Boolean(
      response &&
        response.threadId === scope.threadId &&
        response.userId === 'system' &&
        response.from?.kind === 'system' &&
        response.from.service === 'message_delivery' &&
        lifecycle?.kind === 'delivery_failure' &&
        lifecycle.inputMessageId === message.id &&
        lifecycle.sourceEntryId === expectedEntryId &&
        lifecycle.requestedTargets.includes(scope.catId),
    );
    const handled =
      ref?.phase === 'settled' &&
      (exactDeliveryFailure || (exactResponse && lifecycle?.kind === 'response' && lifecycle.status !== 'processing'));
    // Durable visibility permits a sparse historical drill, not a contiguous replay. The
    // current Queue path must return actual body bytes, not an alreadyExposed marker.
    const availableForContiguousRead =
      !ref &&
      this.options.queue
        ?.getQueuedBodyMessagesForCat(
          scope.threadId,
          scope.userId,
          scope.catId,
          scope.parentInvocationId ?? scope.invocationId,
        )
        .some((entry) => !entry.alreadyExposed && entry.messageId === message.id) === true;
    return {
      messageId: message.id,
      queueEntryId: expectedEntryId,
      threadId: message.threadId,
      sourceThreadId: message.extra?.crossPost?.sourceThreadId ?? message.threadId,
      authorCatId: message.catId,
      targetCatId: scope.catId,
      priority:
        entry?.priority === 'urgent' ? 'urgent' : message.extra?.crossPost?.effectClass === 'fyi' ? 'fyi' : 'normal',
      order: `${String(getTimelineOrderTime(message)).padStart(16, '0')}:${message.id}`,
      nextWork: !availableForContiguousRead,
      facts: {
        persisted: true,
        // No canonical notification witness is available on this projection.
        notified: false,
        readByInvocationIds,
        readInCurrentContext:
          this.options.retainsCurrentInvocationReads?.(scope) === true &&
          readByInvocationIds.includes(scope.invocationId),
        handled,
        playback: 'unknown',
      },
    };
  }
}
