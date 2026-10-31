import type { BallCustodyEvent, WaitContinuationCarrierV1 } from '@cat-cafe/shared';
import type { InvocationRecord } from '../cats/services/agents/invocation/InvocationRegistry.js';
import type { IMessageStore } from '../cats/services/stores/ports/MessageStore.js';
import type { IBallCustodyEventLog } from './BallCustodyEventLog.js';
import type { IBallCustodyFencedIngest } from './BallCustodyIngest.js';
import type { IBallCustodyProjectionStore } from './BallCustodyProjectionStore.js';
import type { ManagedHoldRetiredReason } from './ball-custody-events.js';
import { repairProjectionIfTerminalNotApplied } from './custody-terminal-projection-repair.js';
import { buildWaitDispositionEvent, EVENT_WAIT_DISPOSITIONS, type EventWaitDisposition } from './event-wait-events.js';
import {
  classifyEventWaitWake,
  type EventWaitWakeIdentity,
  eventWaitReceiverHandoffIndex,
  findEventWaitTerminal,
} from './event-wait-wake-state.js';
import { WaitContinuationCarrierError, waitContinuationCarrierFromStoredMessage } from './wait-continuation-carrier.js';
import { waitOutcomeObligation } from './wait-state-machine.js';

export type EventWaitDispositionAuth = Pick<
  InvocationRecord,
  'invocationId' | 'userId' | 'catId' | 'threadId' | 'originTriggerMessageId'
>;

export class EventWaitDispositionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'EventWaitDispositionError';
  }
}

/** Internal retry evidence; the public rejection code stays `event_wait_disposition_fence_conflict`. */
class EventWaitHeartbeatConflict extends EventWaitDispositionError {
  constructor() {
    super('event_wait_disposition_fence_conflict');
  }
}

export interface EventWaitDispositionResult {
  readonly outcome: 'applied' | 'replayed';
  readonly disposition: EventWaitDisposition;
  readonly invocationId: string;
  readonly sourceMessageId: string;
  readonly waitId: string;
  readonly outcomeId: string;
  /** The holder no longer owned the ball, so this closed only its own obligation. */
  readonly retired: boolean;
  /** Present exactly when `retired`. */
  readonly retiredReason?: ManagedHoldRetiredReason;
}

export interface EventWaitDispositionDeps {
  readonly registry: { isLatest(invocationId: string): Promise<boolean> };
  readonly messageStore: Pick<IMessageStore, 'getById'>;
  readonly ballCustodyEventLog: Pick<IBallCustodyEventLog, 'read'>;
  readonly ballCustodyProjectionStore: Pick<IBallCustodyProjectionStore, 'get'>;
  readonly ballCustody: IBallCustodyFencedIngest;
  readonly repairProjection?: (subjectKey: string) => Promise<void>;
  readonly now?: () => number;
  readonly log?: { warn(fields: Record<string, unknown>, message: string): void };
}

interface Wake {
  readonly sourceMessageId: string;
  readonly carrier: WaitContinuationCarrierV1;
}

type ProjectionOutcome = 'accepted' | 'rejected' | 'repaired' | 'unknown';

/** `appended: false` = a duplicate: another write of the same wake identity won, and its terminal is authoritative. */
interface AppendResult {
  readonly appended: boolean;
  readonly projection: ProjectionOutcome;
}

function isDisposition(value: unknown): value is EventWaitDisposition {
  return typeof value === 'string' && (EVENT_WAIT_DISPOSITIONS as readonly string[]).includes(value);
}

/**
 * Invocation-bound terminal producer for the matched event-wait wake this invocation was woken by.
 *
 * #4987 made `matched` a continuation the woken holder still owes, but gave a holder whose work is actually done no
 * way to say so. This is that way, symmetric with `complete_managed_hold` / `complete_a2a_dispatch`: the caller picks
 * only `handled | completed`; the wake, its carrier and the holder are all derived here.
 */
export class EventWaitDispositionService {
  private readonly now: () => number;

  constructor(private readonly deps: EventWaitDispositionDeps) {
    this.now = deps.now ?? Date.now;
  }

  async complete(
    auth: EventWaitDispositionAuth,
    disposition: EventWaitDisposition,
  ): Promise<EventWaitDispositionResult> {
    const wake = await this.resolveWake(auth);
    try {
      return await this.completeWake(auth, disposition, wake);
    } catch (error) {
      // Only a proven heartbeat-only conflict earns one fresh authority check; a second conflict propagates.
      if (!(error instanceof EventWaitHeartbeatConflict)) throw error;
      return this.completeWake(auth, disposition, wake);
    }
  }

  private async assertLatestInvocation(invocationId: string): Promise<void> {
    if (!(await this.deps.registry.isLatest(invocationId))) {
      throw new EventWaitDispositionError('event_wait_disposition_stale_invocation');
    }
  }

  private async resolveWake(auth: EventWaitDispositionAuth): Promise<Wake> {
    await this.assertLatestInvocation(auth.invocationId);
    const sourceMessageId = auth.originTriggerMessageId;
    if (!sourceMessageId) throw new EventWaitDispositionError('event_wait_disposition_no_wake');
    const message = await this.deps.messageStore.getById(sourceMessageId);
    if (!message) throw new EventWaitDispositionError('event_wait_disposition_wake_missing');
    if (message.threadId !== auth.threadId)
      throw new EventWaitDispositionError('event_wait_disposition_thread_mismatch');

    let carrier: WaitContinuationCarrierV1 | undefined;
    try {
      carrier = waitContinuationCarrierFromStoredMessage(message);
    } catch (error) {
      if (error instanceof WaitContinuationCarrierError) {
        throw new EventWaitDispositionError('event_wait_disposition_carrier_invalid');
      }
      throw error;
    }
    if (!carrier) throw new EventWaitDispositionError('event_wait_disposition_not_event_wait');

    const obligation = waitOutcomeObligation(carrier.outcomeId);
    if (obligation === 'unrecognized')
      throw new EventWaitDispositionError('event_wait_disposition_outcome_unrecognized');
    // A self-settling wake only REPORTED that its wait ended: the stop gate never asked for anything, so a terminal
    // would be a second, unasked-for record of nothing.
    if (obligation === 'self_settling') throw new EventWaitDispositionError('event_wait_disposition_nothing_owed');
    return { sourceMessageId, carrier };
  }

  private async completeWake(
    auth: EventWaitDispositionAuth,
    disposition: EventWaitDisposition,
    wake: Wake,
  ): Promise<EventWaitDispositionResult> {
    const { sourceMessageId, carrier } = wake;
    const subjectKey = `ball:thread:${auth.threadId}`;
    const events = await this.deps.ballCustodyEventLog.read(subjectKey);

    // The wake must be the one that handed the ball to THIS cat: that is what makes the obligation this cat's.
    const receiverHandoffIndex = eventWaitReceiverHandoffIndex(events, sourceMessageId, auth.catId);
    if (receiverHandoffIndex === -1) throw new EventWaitDispositionError('event_wait_disposition_handoff_missing');

    // A wake's identity is (cat, wait, outcome), NOT the invocation that happened to settle it: when the queue
    // re-exposes the same wake to a successor invocation, that successor must see the terminal that already exists.
    const identity: EventWaitWakeIdentity = {
      catId: auth.catId,
      waitId: carrier.waitId,
      outcomeId: carrier.outcomeId,
    };
    const prior = findEventWaitTerminal(events, identity);
    if (prior) return this.replay(prior, auth, wake, disposition, events);

    const state = classifyEventWaitWake(events, {
      catId: auth.catId,
      receiverHandoffIndex,
      wakeMessageId: sourceMessageId,
    });
    await this.assertLatestInvocation(auth.invocationId);
    const written = await this.append(
      buildWaitDispositionEvent({
        threadId: auth.threadId,
        catId: auth.catId,
        invocationId: auth.invocationId,
        sourceMessageId,
        waitId: carrier.waitId,
        outcomeId: carrier.outcomeId,
        disposition,
        ...(state.kind === 'retired' ? { retired: true, retiredReason: state.reason } : {}),
        at: this.now(),
      }),
      events.length,
    );

    const after = await this.deps.ballCustodyEventLog.read(subjectKey);
    const committed = findEventWaitTerminal(after, identity);
    if (!committed) throw new EventWaitDispositionError('event_wait_disposition_replay_mismatch');
    const recorded = this.assertSameWake(committed, auth, wake);
    // The read-back must be compared with THIS request, not just with the wake: two concurrent calls inside one
    // invocation can both reach the append, one is recorded and the other is a duplicate of it. The non-recorded
    // one cannot answer `applied` for a value the log does not hold.
    if (committed.payload.invocationId === auth.invocationId && recorded !== disposition) {
      throw new EventWaitDispositionError('event_wait_disposition_replay_mismatch');
    }
    if (written.appended && committed.payload.invocationId === auth.invocationId) {
      // The log authorised the terminal; ingest applies it to the projection cache, which can lag the log. A refusal
      // there means the cache is behind, so converge from the log before anything else reads it.
      if (written.projection === 'rejected') await this.deps.repairProjection?.(subjectKey);
      else if (written.projection === 'unknown') {
        await repairProjectionIfTerminalNotApplied(this.deps, subjectKey, after, committed);
      }
      return this.resultFrom(committed, auth, wake, recorded, 'applied');
    }
    // Lost the race (a duplicate) or a successor wrote it: the recorded terminal is authoritative, and the cache must
    // converge from the log exactly as on any replay.
    await repairProjectionIfTerminalNotApplied(this.deps, subjectKey, after, committed);
    return this.resultFrom(committed, auth, wake, recorded, 'replayed');
  }

  private async replay(
    prior: BallCustodyEvent,
    auth: EventWaitDispositionAuth,
    wake: Wake,
    requested: EventWaitDisposition,
    events: readonly BallCustodyEvent[],
  ): Promise<EventWaitDispositionResult> {
    const recorded = this.assertSameWake(prior, auth, wake);
    // `handled` vs `completed` is the model's free choice each turn and a successor cannot know what its predecessor
    // picked, so across invocations the recorded terminal wins. Inside ONE invocation a conflicting value is a
    // caller bug and keeps failing closed.
    if (prior.payload.invocationId === auth.invocationId && recorded !== requested) {
      throw new EventWaitDispositionError('event_wait_disposition_replay_mismatch');
    }
    // A success receipt is not proof the terminal reached the projection: the append can be durable while the save
    // (and a first repair) failed. Converge from the log, as the managed hold replay does.
    await repairProjectionIfTerminalNotApplied(this.deps, `ball:thread:${auth.threadId}`, events, prior);
    return this.resultFrom(prior, auth, wake, recorded, 'replayed');
  }

  private assertSameWake(event: BallCustodyEvent, auth: EventWaitDispositionAuth, wake: Wake): EventWaitDisposition {
    const recorded = event.payload.disposition;
    if (
      event.kind !== 'ball.wait_dispositioned' ||
      event.payload.catId !== auth.catId ||
      event.payload.sourceMessageId !== wake.sourceMessageId ||
      event.payload.waitId !== wake.carrier.waitId ||
      event.payload.outcomeId !== wake.carrier.outcomeId ||
      !isDisposition(recorded)
    ) {
      throw new EventWaitDispositionError('event_wait_disposition_replay_mismatch');
    }
    return recorded;
  }

  private resultFrom(
    event: BallCustodyEvent,
    auth: EventWaitDispositionAuth,
    wake: Wake,
    disposition: EventWaitDisposition,
    outcome: 'applied' | 'replayed',
  ): EventWaitDispositionResult {
    const reason = event.payload.retiredReason;
    return {
      outcome,
      disposition,
      invocationId: auth.invocationId,
      sourceMessageId: wake.sourceMessageId,
      waitId: wake.carrier.waitId,
      outcomeId: wake.carrier.outcomeId,
      retired: event.payload.retired === true,
      ...(event.payload.retired === true && typeof reason === 'string'
        ? { retiredReason: reason as ManagedHoldRetiredReason }
        : {}),
    };
  }

  /** Append fenced on the snapshot the decision was made from; a heartbeat-only race earns one retry. */
  private async append(event: BallCustodyEvent, expectedSequence: number): Promise<AppendResult> {
    let conflictSequence: number | undefined;
    try {
      const result = await this.deps.ballCustody.recordFenced(event, expectedSequence);
      if (result.outcome === 'conflict') {
        conflictSequence = result.actualSequence;
        throw new EventWaitDispositionError('event_wait_disposition_fence_conflict');
      }
      return result.outcome === 'appended'
        ? { appended: true, projection: result.projection ?? 'unknown' }
        : { appended: false, projection: 'unknown' };
    } catch (caught) {
      let error = caught;
      const events = await this.deps.ballCustodyEventLog.read(event.subjectKey);
      if (conflictSequence !== undefined) {
        const intervening = events.slice(expectedSequence, conflictSequence);
        const heartbeatOnly =
          conflictSequence > expectedSequence &&
          intervening.length === conflictSequence - expectedSequence &&
          intervening.every((candidate) => candidate.kind === 'invocation.heartbeat');
        this.deps.log?.warn(
          {
            subjectKey: event.subjectKey,
            invocationId: event.payload.invocationId,
            outcomeId: event.payload.outcomeId,
            expectedSequence,
            actualSequence: conflictSequence,
            heartbeatOnly,
          },
          '[F167] Event-wait disposition CAS conflict',
        );
        if (heartbeatOnly) error = new EventWaitHeartbeatConflict();
      }
      // The append can land and the apply still throw: converge the projection from the log. But an exception is not a
      // receipt: finding the terminal on the log does not say THIS call wrote it (a concurrent call from the same
      // invocation may have), so the answer stays conservative (`appended: false` -> `replayed` with the recorded value).
      const landed = events.find((candidate) => candidate.sourceEventId === event.sourceEventId);
      if (!landed || !this.deps.repairProjection) throw error;
      await this.deps.repairProjection(event.subjectKey);
      return { appended: false, projection: 'repaired' };
    }
  }
}
