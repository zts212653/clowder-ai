import type { BallCustodyEvent, CatId } from '@cat-cafe/shared';
import type { InvocationRecord } from '../cats/services/agents/invocation/InvocationRegistry.js';
import type { IMessageStore } from '../cats/services/stores/ports/MessageStore.js';
import type { IBallCustodyEventLog } from './BallCustodyEventLog.js';
import type { IBallCustodyIngest } from './BallCustodyIngest.js';
import type { IBallCustodyProjectionStore } from './BallCustodyProjectionStore.js';
import {
  buildHoldDispositionEvent,
  handedEventSourceId,
  holdDispositionEventSourceId,
  type ManagedHoldDisposition,
} from './ball-custody-events.js';
import { ManagedHoldReceiptError, type ManagedHoldReceiptService } from './ManagedHoldReceiptService.js';
import type { ManagedCommandWakeDynamicTaskStore } from './managed-command-wake-lifecycle.js';
import { parseManagedCommandWakeTask } from './managed-command-wake-lifecycle.js';

export interface ManagedHoldDispositionResult {
  readonly outcome: 'applied' | 'replayed';
  readonly disposition: ManagedHoldDisposition;
  readonly invocationId: string;
  readonly sourceMessageId: string;
  readonly taskId: string;
}

export class ManagedHoldDispositionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ManagedHoldDispositionError';
  }
}

interface ManagedHoldDispositionDeps {
  readonly registry: { isLatest(invocationId: string): Promise<boolean> };
  readonly dynamicTaskStore: Pick<ManagedCommandWakeDynamicTaskStore, 'getById'>;
  readonly messageStore: Pick<IMessageStore, 'getById'>;
  readonly ballCustodyEventLog: Pick<IBallCustodyEventLog, 'read'>;
  readonly ballCustodyProjectionStore: Pick<IBallCustodyProjectionStore, 'get'>;
  readonly ballCustody: IBallCustodyIngest;
  readonly receiptService: Pick<ManagedHoldReceiptService, 'complete'>;
  readonly repairProjection?: (subjectKey: string) => Promise<void>;
  readonly now?: () => number;
}

type ManagedHoldDispositionAuth = Pick<
  InvocationRecord,
  'invocationId' | 'userId' | 'catId' | 'threadId' | 'originTriggerMessageId'
>;

function stringMeta(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Invocation-bound terminal producer for an exact managed hold wake. */
export class ManagedHoldDispositionService {
  private readonly now: () => number;

  constructor(private readonly deps: ManagedHoldDispositionDeps) {
    this.now = deps.now ?? Date.now;
  }

  async complete(
    auth: ManagedHoldDispositionAuth,
    disposition: ManagedHoldDisposition,
  ): Promise<ManagedHoldDispositionResult> {
    await this.assertLatestInvocation(auth.invocationId);
    const { sourceMessageId, taskId } = await this.resolveSource(auth);
    this.assertTask(auth, sourceMessageId, taskId);

    const subjectKey = `ball:thread:${auth.threadId}`;
    const events = await this.deps.ballCustodyEventLog.read(subjectKey);
    const eventSourceId = holdDispositionEventSourceId({
      invocationId: auth.invocationId,
      sourceMessageId,
      taskId,
    });
    const prior = events.find((event) => event.sourceEventId === eventSourceId);
    if (prior) {
      this.assertMatchingDispositionEvent(prior, auth, sourceMessageId, taskId, disposition);
      await this.repairProjectionIfNeeded(subjectKey, events, prior);
      await this.completeReceipt(auth, sourceMessageId, taskId);
      return { outcome: 'replayed', disposition, invocationId: auth.invocationId, sourceMessageId, taskId };
    }

    await this.assertCurrentHolder(subjectKey, auth.catId);
    this.assertWakeNotReplaced(events, auth.catId, sourceMessageId, taskId);

    await this.recordDisposition(auth, sourceMessageId, taskId, disposition, subjectKey, eventSourceId);
    const committed = (await this.deps.ballCustodyEventLog.read(subjectKey)).find(
      (event) => event.sourceEventId === eventSourceId,
    );
    this.assertMatchingDispositionEvent(committed, auth, sourceMessageId, taskId, disposition);
    // Consume F264 only after the append-only custody truth is durable. If the
    // receipt write fails, replay repairs it from the exact event; the inverse
    // ordering could delete the only Queue carrier before any terminal event exists.
    await this.completeReceipt(auth, sourceMessageId, taskId);
    return { outcome: 'applied', disposition, invocationId: auth.invocationId, sourceMessageId, taskId };
  }

  private async assertLatestInvocation(invocationId: string): Promise<void> {
    if (!(await this.deps.registry.isLatest(invocationId))) {
      throw new ManagedHoldDispositionError('managed_hold_disposition_stale_invocation');
    }
  }

  private async resolveSource(auth: ManagedHoldDispositionAuth): Promise<{ sourceMessageId: string; taskId: string }> {
    const sourceMessageId = auth.originTriggerMessageId;
    if (!sourceMessageId) throw new ManagedHoldDispositionError('managed_hold_disposition_source_missing');

    const source = await this.deps.messageStore.getById(sourceMessageId);
    const meta = source?.source?.meta;
    const taskId = stringMeta(meta?.taskId);
    if (
      !source ||
      source.source?.connector !== 'hold-ball' ||
      meta?.wakeWhen !== true ||
      !taskId ||
      source.threadId !== auth.threadId ||
      meta?.threadId !== auth.threadId ||
      meta?.catId !== auth.catId
    ) {
      throw new ManagedHoldDispositionError('managed_hold_disposition_source_mismatch');
    }
    return { sourceMessageId, taskId };
  }

  private assertTask(auth: ManagedHoldDispositionAuth, sourceMessageId: string, taskId: string): void {
    const parsed = parseManagedCommandWakeTask(this.deps.dynamicTaskStore.getById(taskId));
    if (
      !parsed ||
      parsed.task.id !== taskId ||
      parsed.threadId !== auth.threadId ||
      parsed.catId !== auth.catId ||
      parsed.userId !== auth.userId ||
      parsed.command.messageId !== sourceMessageId ||
      (parsed.command.state !== 'enqueued' && parsed.command.state !== 'dispatched')
    ) {
      throw new ManagedHoldDispositionError('managed_hold_disposition_task_mismatch');
    }
  }

  private async assertCurrentHolder(subjectKey: string, catId: string): Promise<void> {
    const projection = await this.deps.ballCustodyProjectionStore.get(subjectKey);
    if ((projection?.state !== 'active' && projection?.state !== 'blocked') || projection.holder !== catId) {
      throw new ManagedHoldDispositionError('managed_hold_disposition_holder_mismatch');
    }
  }

  private assertWakeNotReplaced(
    events: readonly BallCustodyEvent[],
    catId: string,
    sourceMessageId: string,
    taskId: string,
  ): void {
    const exactWakeIndex = events.findIndex(
      (event) =>
        event.kind === 'ball.wake_condition_met' && event.payload.taskId === taskId && event.payload.catId === catId,
    );
    if (exactWakeIndex === -1) throw new ManagedHoldDispositionError('managed_hold_disposition_wake_missing');

    const ownReceiverHandoffSourceId = handedEventSourceId(sourceMessageId, catId);
    const wasReplaced = events
      .slice(exactWakeIndex + 1)
      .some(
        (event) =>
          (event.kind === 'ball.held' && event.payload.catId === catId) ||
          (event.kind === 'ball.handed' &&
            event.sourceEventId !== ownReceiverHandoffSourceId &&
            (event.payload.fromCatId === catId || event.payload.toCatId === catId)) ||
          (event.kind === 'ball.handed_cvo' && event.payload.fromCatId === catId),
      );
    if (wasReplaced) throw new ManagedHoldDispositionError('managed_hold_disposition_replaced');
  }

  private assertMatchingDispositionEvent(
    event: BallCustodyEvent | undefined,
    auth: ManagedHoldDispositionAuth,
    sourceMessageId: string,
    taskId: string,
    disposition: ManagedHoldDisposition,
  ): void {
    if (
      !event ||
      event.kind !== 'ball.hold_dispositioned' ||
      event.payload.catId !== auth.catId ||
      event.payload.disposition !== disposition ||
      event.payload.sourceMessageId !== sourceMessageId ||
      event.payload.taskId !== taskId
    ) {
      throw new ManagedHoldDispositionError('managed_hold_disposition_replay_mismatch');
    }
  }

  private async recordDisposition(
    auth: ManagedHoldDispositionAuth,
    sourceMessageId: string,
    taskId: string,
    disposition: ManagedHoldDisposition,
    subjectKey: string,
    eventSourceId: string,
  ): Promise<void> {
    try {
      await this.deps.ballCustody.record(
        buildHoldDispositionEvent({
          threadId: auth.threadId,
          catId: auth.catId,
          invocationId: auth.invocationId,
          sourceMessageId,
          taskId,
          disposition,
          at: this.now(),
        }),
      );
    } catch (error) {
      const appended = (await this.deps.ballCustodyEventLog.read(subjectKey)).find(
        (event) => event.sourceEventId === eventSourceId,
      );
      if (!appended || !this.deps.repairProjection) throw error;
      await this.deps.repairProjection(subjectKey);
    }
  }

  private async repairProjectionIfNeeded(
    subjectKey: string,
    events: readonly BallCustodyEvent[],
    dispositionEvent: BallCustodyEvent,
  ): Promise<void> {
    if (!this.deps.repairProjection) return;
    const dispositionIndex = events.findIndex((event) => event.sourceEventId === dispositionEvent.sourceEventId);
    const reopenedAfterDisposition = events
      .slice(dispositionIndex + 1)
      .some((event) => event.kind === 'ball.handed' || event.kind === 'ball.held');
    const projection = await this.deps.ballCustodyProjectionStore.get(subjectKey);
    if (!reopenedAfterDisposition && projection?.state !== 'resolved') {
      await this.deps.repairProjection(subjectKey);
    }
  }

  private async completeReceipt(
    auth: Pick<InvocationRecord, 'invocationId' | 'userId' | 'catId' | 'threadId'>,
    sourceMessageId: string,
    taskId: string,
  ): Promise<void> {
    try {
      await this.deps.receiptService.complete({
        threadId: auth.threadId,
        userId: auth.userId,
        catId: auth.catId as CatId,
        invocationId: auth.invocationId,
        sourceMessageId,
        taskId,
        handledAt: this.now(),
      });
    } catch (error) {
      if (error instanceof ManagedHoldReceiptError) {
        throw new ManagedHoldDispositionError(error.code);
      }
      throw error;
    }
  }
}
