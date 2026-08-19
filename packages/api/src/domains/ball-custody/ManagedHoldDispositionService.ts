import type { BallCustodyEvent, CatId } from '@cat-cafe/shared';
import type { InvocationRecord } from '../cats/services/agents/invocation/InvocationRegistry.js';
import type { IMessageStore } from '../cats/services/stores/ports/MessageStore.js';
import type { IBallCustodyEventLog } from './BallCustodyEventLog.js';
import type { IBallCustodyFencedIngest } from './BallCustodyIngest.js';
import type { IBallCustodyProjectionStore } from './BallCustodyProjectionStore.js';
import {
  buildHoldDispositionEvent,
  holdDispositionEventSourceId,
  type ManagedHoldDisposition,
} from './ball-custody-events.js';
import { ManagedHoldReceiptError, type ManagedHoldReceiptService } from './ManagedHoldReceiptService.js';
import type { ManagedCommandWakeDynamicTaskStore } from './managed-command-wake-lifecycle.js';
import { parseManagedCommandWakeTask } from './managed-command-wake-lifecycle.js';
import { classifyManagedHoldWake, findWakeTerminal } from './managed-hold-supersession.js';

export interface ManagedHoldDispositionResult {
  readonly outcome: 'applied' | 'replayed';
  readonly disposition: ManagedHoldDisposition;
  readonly invocationId: string;
  readonly sourceMessageId: string;
  readonly taskId: string;
  /** The wake reached a terminal but was no longer the subject's live wake. */
  readonly retired: boolean;
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
  readonly ballCustody: IBallCustodyFencedIngest;
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
    // Identity stays fail-closed exactly as before; the command state no longer
    // routes anything, so this is now a pure assertion.
    this.assertCarrierIdentity(auth, sourceMessageId, taskId);

    const subjectKey = `ball:thread:${auth.threadId}`;
    const events = await this.deps.ballCustodyEventLog.read(subjectKey);
    // The written event keeps its invocation-scoped audit identity...
    const eventSourceId = holdDispositionEventSourceId({
      invocationId: auth.invocationId,
      sourceMessageId,
      taskId,
    });
    // ...but a wake's identity is (catId, sourceMessageId, taskId), NOT the
    // invocation that happened to settle it. Sol R2 P1: production writes the
    // custody event before settling the F264 receipt, so a receipt failure makes
    // Queue re-expose the same wake to a successor invocation. Looking the prior
    // up by the invocation-scoped sourceEventId made that successor blind to the
    // existing terminal — it either could not settle the carrier at all, or wrote
    // a second terminal for one wake.
    const prior = findWakeTerminal(events, { catId: auth.catId, sourceMessageId, taskId });
    if (prior) {
      const canonical = this.assertReplayableTerminal(prior, auth, sourceMessageId, taskId, disposition);
      await this.repairProjectionIfNeeded(subjectKey, events, prior);
      await this.completeReceipt(auth, sourceMessageId, taskId);
      return {
        outcome: 'replayed',
        disposition: canonical,
        invocationId: auth.invocationId,
        sourceMessageId,
        taskId,
        retired: prior.payload.retired === true,
      };
    }

    // clowder-ai#1366: a late or superseded wake still needs a deterministic
    // terminal. Refusing it (the old behaviour) left no `ball.hold_dispositioned`
    // for the stop gate to recognize, so the same wake was reinjected forever.
    const supersession = classifyManagedHoldWake(events, {
      catId: auth.catId,
      sourceMessageId,
      taskId,
    });
    if (supersession.kind === 'wake_missing') {
      throw new ManagedHoldDispositionError('managed_hold_disposition_wake_missing');
    }
    // `retired` is derived ONLY from custody supersession — never from the command
    // carrier. A terminal carrier explains why a callback arrived late; it does not
    // mean something else took the ball. Sol REQUEST_CHANGES P1: deriving it from
    // the carrier made a still-live wake write a subject-inert terminal, so the
    // Queue receipt closed while `ball:thread:X` leaked in `active` forever.
    const retired = supersession.kind === 'superseded';
    // Retired terminals are inert on the subject plane, so they need not own the
    // ball. Any disposition that DOES advance the subject still must.
    if (!retired) await this.assertCurrentHolder(subjectKey, auth.catId);

    await this.recordDisposition(
      auth,
      sourceMessageId,
      taskId,
      disposition,
      subjectKey,
      eventSourceId,
      events.length,
      retired,
    );
    const committed = (await this.deps.ballCustodyEventLog.read(subjectKey)).find(
      (event) => event.sourceEventId === eventSourceId,
    );
    this.assertMatchingDispositionEvent(committed, auth, sourceMessageId, taskId, disposition);
    // Consume F264 only after the append-only custody truth is durable. If the
    // receipt write fails, replay repairs it from the exact event; the inverse
    // ordering could delete the only Queue carrier before any terminal event exists.
    await this.completeReceipt(auth, sourceMessageId, taskId);
    return { outcome: 'applied', disposition, invocationId: auth.invocationId, sourceMessageId, taskId, retired };
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

  /**
   * Identity is fail-closed exactly as before.
   *
   * What changed for clowder-ai#1366 is only that the command *state* no longer
   * hard-rejects: a task that already left the active delivery states (or whose
   * row is gone) is a late callback, not a forged one, so it may still reach a
   * terminal. Whether that terminal advances the subject is decided solely by
   * custody supersession — never here.
   */
  private assertCarrierIdentity(auth: ManagedHoldDispositionAuth, sourceMessageId: string, taskId: string): void {
    const parsed = parseManagedCommandWakeTask(this.deps.dynamicTaskStore.getById(taskId));
    // The message-side identity (connector, wakeWhen, taskId, thread, cat) was
    // already verified in resolveSource, so a missing row is a late callback,
    // not an unverified caller.
    if (!parsed) return;
    if (
      parsed.task.id !== taskId ||
      parsed.threadId !== auth.threadId ||
      parsed.catId !== auth.catId ||
      parsed.userId !== auth.userId ||
      parsed.command.messageId !== sourceMessageId
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

  /**
   * Validate an existing terminal for this exact wake and return its canonical
   * disposition.
   *
   * Sol R4 P1: `handled` vs `completed` is the model's free choice each turn, and
   * a successor invocation cannot know what its predecessor picked. Demanding the
   * same value made the current F264 exposure permanently unsettleable, so the
   * carrier kept recovering — the exact opposite of "already-dispositioned is
   * idempotent".
   *
   * The recorded terminal stays authoritative: it is never rewritten and no second
   * event is appended. Within ONE invocation a conflicting value is still a caller
   * bug, so that case keeps failing closed and preserves concurrent linearization.
   */
  private assertReplayableTerminal(
    prior: BallCustodyEvent,
    auth: ManagedHoldDispositionAuth,
    sourceMessageId: string,
    taskId: string,
    requested: ManagedHoldDisposition,
  ): ManagedHoldDisposition {
    const recorded = prior.payload.disposition;
    if (
      prior.kind !== 'ball.hold_dispositioned' ||
      prior.payload.catId !== auth.catId ||
      prior.payload.sourceMessageId !== sourceMessageId ||
      prior.payload.taskId !== taskId ||
      (recorded !== 'handled' && recorded !== 'completed')
    ) {
      throw new ManagedHoldDispositionError('managed_hold_disposition_replay_mismatch');
    }
    if (prior.payload.invocationId === auth.invocationId && recorded !== requested) {
      throw new ManagedHoldDispositionError('managed_hold_disposition_replay_mismatch');
    }
    return recorded;
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
    expectedSequence: number,
    retired: boolean,
  ): Promise<void> {
    try {
      const result = await this.deps.ballCustody.recordFenced(
        buildHoldDispositionEvent({
          threadId: auth.threadId,
          catId: auth.catId,
          invocationId: auth.invocationId,
          sourceMessageId,
          taskId,
          disposition,
          retired,
          at: this.now(),
        }),
        expectedSequence,
      );
      if (result.outcome === 'conflict') {
        throw new ManagedHoldDispositionError('managed_hold_disposition_fence_conflict');
      }
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
