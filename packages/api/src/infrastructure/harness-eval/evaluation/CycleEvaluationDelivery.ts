import type { CatId, CycleRecord } from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../../../domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../../../domains/cats/services/stores/ports/ThreadStore.js';
import type { DeliverOpts, ScheduleInvokeTrigger } from '../../scheduler/types.js';
import { ensureEvalDomainThreads } from '../hub/eval-hub-thread-ensure.js';
import type { ObjectiveEvaluationRuntime } from './ObjectiveEvaluationRuntime.js';

export function cycleEvaluationThreadId(objectiveId: string): string {
  return `thread_eval_f257_${objectiveId}`;
}

/** Whether an evaluation wake reached the evaluator, read from the wake message's durable Queue custody. */
export type CycleWakeReceipt =
  | { state: 'pending' }
  | { state: 'delivered'; deliveredAt: number }
  /** Nothing durable will ever report this wake: gone, canceled, or terminal before any exposure. */
  | { state: 'dead' };

/**
 * The receipt is the first exact body exposure: append-only on the custody
 * record, so it survives a restart and no later queue state takes it back.
 * Queue position is not a receipt — a start that fails moves the entry
 * queued → processing → queued without the evaluator ever seeing the wake.
 */
export function resolveCycleWakeReceipt(
  message: Pick<StoredMessage, 'deliveryStatus' | 'queueCustody'> | null | undefined,
): CycleWakeReceipt {
  const custody = message?.queueCustody;
  const exposures = custody?.bodyExposures ?? [];
  if (exposures.length > 0) {
    return { state: 'delivered', deliveredAt: Math.min(...exposures.map((exposure) => exposure.seenAt)) };
  }
  if (!message || !custody || message.deliveryStatus === 'canceled') return { state: 'dead' };
  if (custody.status === 'terminal' || custody.pendingTargetCats.length === 0) return { state: 'dead' };
  return { state: 'pending' };
}

/**
 * The wake key is idempotent, so the stored source decides whether a send may
 * enter the Queue: a queued message with no custody yet (first admission), or
 * one whose live custody has not delivered it (its exact carrier continues, or
 * the trigger's verified replacement takes it over). A delivered, canceled or
 * terminal source gets no new row — nothing could ever take durable ownership
 * of it, and it would sit in the Queue as unfinished work forever.
 */
export function wakeAwaitsQueueAdmission(
  message: Pick<StoredMessage, 'deliveryStatus' | 'queueCustody'> | null | undefined,
): boolean {
  if (!message || message.deliveryStatus !== 'queued') return false;
  return !message.queueCustody || resolveCycleWakeReceipt(message).state === 'pending';
}

/**
 * The Objective evaluation thread and the wakes sent into it. Split from the
 * coordinator so the cycle state machine and its delivery mechanics each stay
 * readable; the coordinator owns every CycleRecord transition.
 */
export class CycleEvaluationDelivery {
  /** Concurrent sends of one key share one delivery, so none acts on a source another is changing. */
  private readonly inFlight = new Map<string, Promise<string>>();

  constructor(
    private readonly deps: {
      runtime: Pick<ObjectiveEvaluationRuntime, 'catalog'>;
      threadStore: IThreadStore;
      messageStore: Pick<IMessageStore, 'getById'>;
      deliver: (input: DeliverOpts) => Promise<string>;
      getInvokeTrigger: () => ScheduleInvokeTrigger | null;
      getDefaultCatId: () => CatId;
    },
  ) {}

  async ensureObjectiveThread(objectiveId: string, ownerUserId: string): Promise<{ threadId: string; catId: CatId }> {
    const objective = this.deps.runtime.catalog.registry.objectives.find((item) => item.id === objectiveId);
    if (!objective) throw new Error(`cycle_objective_not_found:${objectiveId}`);
    if (objective.lifecycle === 'retired') throw new Error(`cycle_objective_retired:${objectiveId}`);
    const threadId = cycleEvaluationThreadId(objectiveId);
    await ensureEvalDomainThreads(
      this.deps.threadStore,
      [
        {
          domainId: `f257:${objectiveId}`,
          systemThreadId: threadId,
          displayName: `Harness Objective · ${objective.label}`,
        },
      ],
      ownerUserId,
    );
    const existing = await this.deps.threadStore.get(threadId);
    if (!existing) throw new Error(`cycle_evaluation_thread_missing:${threadId}`);
    const catId = existing.preferredCats?.[0] ?? this.deps.getDefaultCatId();
    if (!existing.preferredCats?.length) await this.deps.threadStore.updatePreferredCats(threadId, [catId]);
    await this.deps.threadStore.addParticipants(threadId, [catId]);
    return { threadId, catId };
  }

  /**
   * Deliver + wake through the Queue even when the thread is idle: a message
   * stored `queued` and force-queued gets durable custody, which is where the
   * delivery receipt comes from. An idle thread starts the entry at once.
   */
  deliverWake(record: CycleRecord, threadId: string, catId: CatId, content: string, kind: string): Promise<string> {
    const key = this.idempotencyKey(record, kind);
    const shared = this.inFlight.get(key);
    if (shared) return shared;
    const delivery = this.deliverOnce(record, threadId, catId, content, kind, key).finally(() =>
      this.inFlight.delete(key),
    );
    this.inFlight.set(key, delivery);
    return delivery;
  }

  private async deliverOnce(
    record: CycleRecord,
    threadId: string,
    catId: CatId,
    content: string,
    kind: string,
    idempotencyKey: string,
  ): Promise<string> {
    const messageId = await this.deps.deliver({
      threadId,
      userId: record.ownerUserId,
      content,
      idempotencyKey,
      deliveryStatus: 'queued',
    });
    if (!wakeAwaitsQueueAdmission(await this.deps.messageStore.getById(messageId))) return messageId;
    const trigger = this.deps.getInvokeTrigger();
    if (!trigger) throw new Error('cycle_invoke_trigger_unavailable');
    const outcome = await trigger.trigger(
      threadId,
      catId,
      record.ownerUserId,
      `F257 cycle ${kind}: ${record.cycleId}`,
      messageId,
      undefined,
      // Two declarations, two readers. `forceQueue` makes the Queue custody this
      // wake even when the thread is idle, so its delivery receipt is durable.
      // `sourceCategory` is how turn custody classifies the evaluator's turn: a
      // cycle wake is a scheduler fire, and leaving that unsaid does not read as
      // "scheduled with no extras" — resolveQueueTurnCustodyWake falls past every
      // branch to `legacy/carrier_missing`, which opens as `unknown_legacy`. That
      // state carries no baseline, so the F167 stop gate blocks the turn
      // unconditionally and nothing the evaluator does can clear it (#180).
      { forceQueue: true, sourceCategory: 'scheduled', reason: `F257 cycle ${kind}` },
    );
    if (outcome === 'full') throw new Error('cycle_invocation_queue_full');
    return messageId;
  }

  idempotencyKey(record: CycleRecord, kind: string): string {
    // Reject deliberately re-evaluates the same frozen window under the same
    // cycleId. The rejection count is therefore the delivery generation: it
    // deduplicates retries within one attempt without hiding the next
    // assignment (and its operator-provided rejection reason).
    const generation = record.approval?.rejectCount ?? 0;
    return `f257-cycle:${record.ownerUserId}:${record.cycleId}:${kind}:g${generation}`;
  }
}
