/**
 * Phase 4 (AC-H1): Delivery function factory for scheduled task execution.
 * Templates call deliver() to post messages to threads without going through MCP callbacks.
 */
import { randomUUID } from 'node:crypto';
import type { CatId } from '@cat-cafe/shared';
import { normalizeOwnerAuthProvenance } from '../../domains/cats/services/owner-auth-provenance.js';
import type { StoredMessage } from '../../domains/cats/services/stores/ports/MessageStore.js';
import type { DeliverOpts, ScheduleLifecycleNotice } from './types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

export interface DeliveryDeps {
  messageStore: { append: AnyFn };
  socketManager: { broadcastToRoom: AnyFn; emitToUser: AnyFn };
  /** RFC §5.1: the one component that turns a producer envelope into durable Queue work. */
  persistedQueueDelivery?: import('../../domains/cats/services/agents/invocation/PersistedQueueDelivery.js').PersistedQueueDeliveryPort;
}

export const SCHEDULER_SOURCE = {
  connector: 'scheduler',
  label: '定时任务',
  icon: 'scheduler',
} as const;

/** RFC §5.4: admit a target-only payload — same Queue and drain, no public History member. */
export function createDeliverPrivateFn(
  deps: Pick<DeliveryDeps, 'persistedQueueDelivery'>,
): (opts: import('./types.js').PrivateDeliverOpts) => Promise<void> {
  return async (opts): Promise<void> => {
    if (!deps.persistedQueueDelivery) throw new Error('scheduler private Queue admission requires a delivery port');
    const admitted = await deps.persistedQueueDelivery.deliverPrivate({
      ownerUserId: opts.userId,
      threadId: opts.threadId,
      targetCatId: opts.targetCatId,
      idempotencyKey: opts.idempotencyKey,
      content: opts.content,
      from: { kind: 'system', service: SCHEDULER_SOURCE.connector },
      ...(opts.priority ? { priority: opts.priority } : {}),
      ...(opts.sourceCategory ? { sourceCategory: opts.sourceCategory } : {}),
      ownerAuthProvenance: normalizeOwnerAuthProvenance(opts.ownerAuthProvenance),
    });
    if (!admitted.admitted) throw new Error('scheduler private Queue admission did not happen');
  };
}

export function createDeliverFn(deps: DeliveryDeps): (opts: DeliverOpts) => Promise<string> {
  /** A message the thread should show and no member must act on: History only, never a Queue row. */
  const visibleNotice = (opts: DeliverOpts, source: DeliverOpts['source'] & object) => ({
    from: { kind: 'system' as const, service: source.connector },
    userId: opts.userId,
    content: opts.content,
    mentions: [] as readonly CatId[],
    origin: 'callback' as const,
    timestamp: Date.now(),
    threadId: opts.threadId,
    source,
    ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
    ...(opts.extra ? { extra: opts.extra } : {}),
  });

  const broadcastVisible = (opts: DeliverOpts, source: DeliverOpts['source'] & object, stored: StoredMessage): void => {
    const schedulerExtra = stored.extra?.scheduler ?? opts.extra?.scheduler;
    deps.socketManager.broadcastToRoom(`thread:${opts.threadId}`, 'connector_message', {
      threadId: opts.threadId,
      message: {
        id: stored.id,
        type: 'connector',
        content: typeof stored.content === 'string' ? stored.content : opts.content,
        source,
        ...(schedulerExtra ? { extra: { scheduler: schedulerExtra } } : {}),
        timestamp: stored.timestamp,
      },
    });
  };

  return async (opts: DeliverOpts): Promise<string> => {
    const source = opts.source ?? SCHEDULER_SOURCE;

    // A scheduled input that needs a member to act is the same `conversation_input` envelope a user
    // send builds. One transaction persists it and admits it; Queue drain owes the wake. Producers
    // never append a hidden source and bind it afterwards, so there is no window to compensate for.
    if (opts.targetCatId) {
      if (!deps.persistedQueueDelivery) throw new Error('scheduler Queue admission requires a delivery port');
      if (!opts.idempotencyKey) throw new Error('scheduler Queue admission requires a stable idempotencyKey');

      // When the target's exact input differs from what the thread should show, the public line is
      // an ordinary History-only message and the payload is a `private_input` Queue entry. Both are
      // still one Queue, one drain — the split is in visibility, never in the reliability path.
      if (opts.privateContent !== undefined) {
        // One transaction persists the visible line and admits the target's payload. Publishing
        // first and admitting afterwards would leave a visible "triggered" notice with no work
        // behind it whenever the Queue refuses or the process dies between the two writes.
        const admission = await deps.persistedQueueDelivery.deliverVisibleWithPrivateInput({
          ownerUserId: opts.userId,
          threadId: opts.threadId,
          targetCatId: opts.targetCatId,
          idempotencyKey: `${opts.idempotencyKey}:private`,
          content: opts.privateContent,
          from: { kind: 'system', service: source.connector },
          notice: visibleNotice(opts, source),
          ...(opts.priority ? { priority: opts.priority } : {}),
          ...(opts.sourceCategory ? { sourceCategory: opts.sourceCategory } : {}),
          ownerAuthProvenance: normalizeOwnerAuthProvenance(opts.ownerAuthProvenance),
        });
        if (!admission.admitted) throw new Error('scheduler private Queue admission did not happen');
        const stored = admission.notice;
        if (!stored) throw new Error('scheduler visible notice did not persist with its private input');
        broadcastVisible(opts, source, stored);
        return stored.id;
      }

      const admitted = await deps.persistedQueueDelivery.deliver({
        ownerUserId: opts.userId,
        threadId: opts.threadId,
        targetCatId: opts.targetCatId,
        idempotencyKey: opts.idempotencyKey,
        content: opts.content,
        source,
        from: { kind: 'system', service: source.connector },
        ...(opts.extra ? { extra: opts.extra as never } : {}),
        ...(opts.priority ? { priority: opts.priority } : {}),
        ...(opts.suggestedSkill ? { suggestedSkill: opts.suggestedSkill } : {}),
        ...(opts.sourceCategory ? { sourceCategory: opts.sourceCategory } : {}),
        // Never inherit the producer-default: an ordinary scheduled wake carries an authenticated
        // owner but NOT a private managed-hold continuation proof. Only hold-ball may project strict.
        ownerAuthProvenance: normalizeOwnerAuthProvenance(opts.ownerAuthProvenance),
      });
      if (admitted.state === 'conflict' || admitted.state === 'unavailable') {
        throw new Error(`scheduler Queue admission did not happen: ${admitted.state}`);
      }
      return admitted.message?.id ?? '';
    }

    const stored = await deps.messageStore.append({
      ...visibleNotice(opts, source),
      ...(opts.deliveryStatus ? { deliveryStatus: opts.deliveryStatus } : {}),
    });
    if (opts.deliveryStatus === 'queued') return stored.id;
    broadcastVisible(opts, source, stored);
    return stored.id;
  };
}

export function createLifecycleToastFn(
  deps: Pick<DeliveryDeps, 'socketManager'>,
): (notice: ScheduleLifecycleNotice) => void {
  return (notice: ScheduleLifecycleNotice): void => {
    deps.socketManager.emitToUser(notice.userId, 'connector_message', {
      threadId: notice.threadId,
      message: {
        id: `scheduler-toast-${Date.now()}-${randomUUID().slice(0, 8)}`,
        type: 'connector',
        content: notice.toast.message,
        source: SCHEDULER_SOURCE,
        extra: { scheduler: { toast: notice.toast } },
        timestamp: Date.now(),
      },
    });
  };
}
