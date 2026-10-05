import type { InvocationQueue } from '../../../cats/services/agents/invocation/InvocationQueue.js';
import { isFreshnessRoutableMessage } from '../../../cats/services/freshness/checkFreshnessForPostMessage.js';
import type { IMessageStore, StoredMessage } from '../../../cats/services/stores/ports/MessageStore.js';
import { canViewMessage, getTimelineOrderTime } from '../../../cats/services/stores/visibility.js';
import type { LiveInboxReference, LiveInboxScope, LiveInboxSource } from './live-inbox-contract.js';

export interface MessageLiveInboxOptions {
  store: Pick<IMessageStore, 'getByThreadAfter' | 'getById'>;
  /** Current contiguous Queue body selection, including same-child metadata-only exposure. Missing means no notice. */
  queue?: Pick<InvocationQueue, 'getQueuedBodyMessagesForCat'>;
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
    await this.assertAuthorized(scope);
    return {
      items: messages
        .map((message) => this.project(scope, message))
        .filter((item): item is LiveInboxReference => item !== null),
      // This is an ephemeral raw-timeline cursor, never a seen cursor. A lost anchor rescans,
      // and a process restart always reads canonical custody again from the beginning.
      nextCursor: messages.at(-1)?.id,
      hasMore: messages.length === limit,
    };
  }
  async read(scope: LiveInboxScope, messageId: string): Promise<LiveInboxReference | null> {
    await this.assertAuthorized(scope);
    const message = await this.options.store.getById(messageId);
    await this.assertAuthorized(scope);
    return message ? this.project(scope, message) : null;
  }

  private async assertAuthorized(scope: LiveInboxScope): Promise<void> {
    if (!(await this.options.authorize(scope))) throw new LiveInboxAuthorityUnavailableError();
  }

  private project(scope: LiveInboxScope, message: StoredMessage): LiveInboxReference | null {
    const custody = message.queueCustody;
    if (
      message.userId !== scope.userId ||
      message.threadId !== scope.threadId ||
      message.deletedAt !== undefined ||
      message.recall ||
      message.deliveryStatus === 'canceled' ||
      !canViewMessage(message, { type: 'cat', catId: scope.catId }) ||
      !isFreshnessRoutableMessage(message) ||
      this.options.isSameCallExposure?.(message) ||
      !custody?.allTargetCats.includes(scope.catId) ||
      custody.withdrawnByCatIds?.includes(scope.catId)
    )
      return null;
    // Durable visibility permits a sparse historical drill, not a contiguous replay. The
    // current Queue path must return actual body bytes, not an alreadyExposed marker.
    const availableForContiguousRead =
      this.options.queue
        ?.getQueuedBodyMessagesForCat(
          scope.threadId,
          scope.userId,
          scope.catId,
          scope.parentInvocationId ?? scope.invocationId,
          scope.invocationId,
        )
        .some(
          (entry) =>
            !entry.alreadyExposedToInvocation &&
            (entry.messageId === message.id || entry.mergedMessageIds?.includes(message.id)),
        ) === true;
    return {
      messageId: message.id,
      queueEntryId: custody.carrierByTargetCatId?.[scope.catId]?.entryId ?? custody.entryId,
      threadId: message.threadId,
      sourceThreadId: message.extra?.crossPost?.sourceThreadId ?? message.threadId,
      authorCatId: message.catId,
      targetCatId: scope.catId,
      priority:
        custody.priority === 'urgent' ? 'urgent' : message.extra?.crossPost?.effectClass === 'fyi' ? 'fyi' : 'normal',
      order: `${String(getTimelineOrderTime(message)).padStart(16, '0')}:${message.id}`,
      nextWork: !availableForContiguousRead,
      facts: {
        persisted: true,
        notified: custody.notifiedByCatIds.includes(scope.catId),
        readByInvocationIds: [
          ...new Set(
            (custody.bodyExposures ?? [])
              .filter((exposure) => exposure.targetCatId === scope.catId)
              .map((exposure) => exposure.invocationId),
          ),
        ],
        readInCurrentContext:
          this.options.retainsCurrentInvocationReads?.(scope) === true &&
          (custody.bodyExposures ?? []).some(
            (exposure) => exposure.targetCatId === scope.catId && exposure.invocationId === scope.invocationId,
          ),
        handled:
          custody.handledByCatIds.includes(scope.catId) ||
          custody.targetOutcomeByCatId?.[scope.catId] !== undefined ||
          (custody.status === 'terminal' && !custody.pendingTargetCats.includes(scope.catId)),
        playback: 'unknown',
      },
    };
  }
}
