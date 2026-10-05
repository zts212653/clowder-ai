import { type BallCustodyEvent, isCrossThreadProvenance } from '@cat-cafe/shared';
import type { InvocationRecord } from '../cats/services/agents/invocation/InvocationRegistry.js';
import type { IMessageStore, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import type { LiveCarrierOperationLease } from '../concierge/live/LiveCarrierOperationGate.js';
import {
  type A2ADispatchHandoffInspection,
  type A2ADispatchHandoffSource,
  resolveA2ADispatchHandoff,
} from './A2ADispatchReplacementResolver.js';
import { A2ADispatchDispositionError, dispatchReplayMismatch } from './a2a-dispatch-disposition-error.js';
import type { IBallCustodyEventLog } from './BallCustodyEventLog.js';
import type { IBallCustodyFencedIngest } from './BallCustodyIngest.js';
import type { IBallCustodyProjectionStore } from './BallCustodyProjectionStore.js';
import type { DispatchDispositionEventInput } from './ball-custody-events.js';
import {
  type A2ADispatchDisposition,
  buildDispatchDispositionEvent,
  dispatchDispositionEventSourceId,
  handedEventSourceId,
} from './ball-custody-events.js';
import { findDispatchTerminal } from './dispatch-terminal.js';

export interface A2ADispatchDispositionResult {
  readonly outcome: 'applied' | 'replayed';
  readonly disposition: A2ADispatchDisposition;
  readonly invocationId: string;
  readonly sourceMessageId: string;
  readonly fromCatId: string;
  /** The exact dispatch ended without advancing an unrelated thread-level holder. */
  readonly retired: boolean;
}

export type { A2ADispatchHandoffInspection, A2ADispatchReplacement } from './A2ADispatchReplacementResolver.js';

export { A2ADispatchDispositionError };

/**
 * Evidence kinds accepted for adopted dispatch read-witness.
 * Only durable, server-recorded contiguous reads qualify — partial,
 * queue-exact, or client-asserted kinds are rejected.
 */
const ALLOWED_ADOPTED_EVIDENCE_KINDS: ReadonlySet<string> = new Set(['full_contiguous_thread_context']);

/** Query shape for the Live carrier predicate (F317 dispatch adoption). */
export interface LiveCarrierQuery {
  readonly invocationId: string;
  readonly catId: string;
  readonly threadId: string;
}

/** Durable, invocation-bound read-evidence witness for adopted dispatch. */
export interface ReadEvidenceWitness {
  readonly messageId: string;
  /** Unix ms when the invocation's contiguous/exact read covered this message. */
  readonly seenAt: number;
  /** Evidence provenance, e.g. 'full_contiguous_thread_context' or 'queue_exact_read'. */
  readonly evidenceKind: string;
}

export interface DispatchAdoptionProof {
  readonly carrierKind: 'ordinary' | 'live';
  readonly witness: ReadEvidenceWitness;
  readonly assertSourceCurrent?: () => Promise<void>;
}

interface DispatchAdoptionAuthorityPort {
  run<T>(
    auth: A2ADispatchDispositionAuth,
    messageId: string,
    consume: (proof: DispatchAdoptionProof) => Promise<T>,
  ): Promise<T>;
  candidates(auth: A2ADispatchDispositionAuth, messageIds: readonly string[]): Promise<string[]>;
}

interface A2ADispatchDispositionDeps {
  readonly adoptionAuthority?: DispatchAdoptionAuthorityPort;
  readonly registry: { isLatest(invocationId: string): Promise<boolean> };
  readonly messageStore: Pick<IMessageStore, 'getById'>;
  readonly ballCustodyEventLog: Pick<IBallCustodyEventLog, 'read'>;
  readonly ballCustodyProjectionStore: Pick<IBallCustodyProjectionStore, 'get'>;
  readonly ballCustody: IBallCustodyFencedIngest;
  readonly log?: { warn(obj: unknown, msg?: string): void };
  readonly repairProjection?: (subjectKey: string) => Promise<void>;
  readonly now?: () => number;
  /** Durable event precedes the exact-source Queue receipt; replay must repair a partial write. */
  readonly projectAdoptedDisposition?: (input: {
    threadId: string;
    catId: string;
    sourceMessageId: string;
  }) => Promise<void>;
  readonly withLiveCarrierOperation?: <T>(
    query: LiveCarrierQuery,
    operation: (lease: LiveCarrierOperationLease) => Promise<T>,
  ) => Promise<T>;
  /**
   * F317 Live dispatch adoption: server-owned predicate backed by
   * LiveCompanionSessions. Returns true only when the invocation is currently
   * bound to an active (non-terminal) live session. When undefined, the adopted
   * dispatch path is unavailable (503 fail-closed).
   */
  readonly isLiveCarrierInvocation?: (query: LiveCarrierQuery) => Promise<boolean>;
  /**
   * F317 dispatch adoption read-evidence gate: returns durable, invocation-bound
   * evidence that this invocation has read a specific message. Must cover the
   * adopted dispatch source message and have been recorded after the handoff.
   * When undefined, the adopted dispatch path is unavailable (503 fail-closed).
   */
  readonly getReadEvidenceForMessage?: (query: {
    invocationId: string;
    catId: string;
    threadId: string;
    messageId: string;
  }) => Promise<ReadEvidenceWitness | null>;
}

export type A2ADispatchDispositionAuth = Pick<
  InvocationRecord,
  'invocationId' | 'catId' | 'threadId' | 'a2aTriggerMessageId' | 'originTriggerMessageId'
> &
  Partial<Pick<InvocationRecord, 'userId'>>;

type DispatchSource = A2ADispatchHandoffSource;

/** Invocation-bound terminal producer for one exact ordinary A2A dispatch. */
export class A2ADispatchDispositionService {
  private readonly now: () => number;

  constructor(private readonly deps: A2ADispatchDispositionDeps) {
    this.now = deps.now ?? Date.now;
  }

  async complete(
    auth: A2ADispatchDispositionAuth,
    disposition: A2ADispatchDisposition,
  ): Promise<A2ADispatchDispositionResult> {
    try {
      return await this.completeLatestInvocation(auth, disposition);
    } catch (error) {
      if (!(error instanceof A2ADispatchDispositionError) || error.code !== 'a2a_dispatch_disposition_fence_conflict') {
        throw error;
      }
      // Heartbeats share the subject log. Retry once from fresh authority and
      // lineage, never by appending the previously inspected disposition.
      return this.completeLatestInvocation(auth, disposition);
    }
  }

  private async completeLatestInvocation(
    auth: A2ADispatchDispositionAuth,
    disposition: A2ADispatchDisposition,
  ): Promise<A2ADispatchDispositionResult> {
    await this.assertLatestInvocation(auth.invocationId);
    const source = await this.resolveSource(auth);
    return this.completeResolved(auth, source, disposition);
  }

  /**
   * A consumed coordination terminal is the exact completion witness for the
   * ordinary dispatch that invoked its author. It shares the existing
   * disposition event/fence; no second terminal lifecycle is created.
   */
  async completeFromCoordinationTerminal(terminalMessageId: string): Promise<A2ADispatchDispositionResult> {
    const terminal = await this.deps.messageStore.getById(terminalMessageId);
    const coordination = terminal?.extra?.coordination;
    const provenance = terminal?.extra?.crossPost;
    const causal = terminal?.extra?.causal;
    const turnInvocationId = terminal?.extra?.stream?.turnInvocationId;
    if (
      !terminal ||
      !terminal.catId ||
      coordination?.phase !== 'terminal' ||
      !provenance?.sourceThreadId ||
      !provenance.sourceInvocationId ||
      !causal?.triggerMessageId ||
      !turnInvocationId
    ) {
      throw new A2ADispatchDispositionError('a2a_dispatch_coordination_terminal_identity_missing');
    }

    const auth: A2ADispatchDispositionAuth = {
      invocationId: provenance.sourceInvocationId,
      catId: terminal.catId,
      threadId: provenance.sourceThreadId,
      a2aTriggerMessageId: causal.triggerMessageId,
      originTriggerMessageId: causal.triggerMessageId,
    };
    const sourceMessage = await this.deps.messageStore.getById(causal.triggerMessageId);
    const sourceCoordination = sourceMessage?.extra?.coordination;
    const sourceOriginThreadId = sourceMessage?.extra?.crossPost?.sourceThreadId;
    const terminalTargetsSource = Boolean(
      sourceMessage?.catId && this.messageTargetsCat(terminal, sourceMessage.catId),
    );
    if (
      !sourceMessage ||
      sourceCoordination?.phase !== 'active' ||
      coordination.id !== sourceCoordination.id ||
      coordination.hop !== sourceCoordination.hop + 1 ||
      !coordination.subjectRef ||
      !sourceCoordination.subjectRef ||
      coordination.subjectRef !== sourceCoordination.subjectRef ||
      sourceOriginThreadId !== terminal.threadId ||
      terminal.threadId === provenance.sourceThreadId ||
      terminal.userId !== sourceMessage.userId ||
      turnInvocationId !== provenance.sourceInvocationId ||
      !terminalTargetsSource
    ) {
      throw new A2ADispatchDispositionError('a2a_dispatch_coordination_terminal_mismatch');
    }

    const source = await this.resolveSource(auth);
    return this.completeResolved(auth, source, 'completed', undefined, undefined, 'coordination_terminal');
  }

  /**
   * Complete a dispatch that was not the invocation's own trigger, admitted by
   * its exact carrier/read authority. Bypasses the trigger identity fence (Fence B)
   * but validates: (1) Live carrier credential, (2) source targets this cat,
   * (3) invocation is latest. Records `adopted` provenance on the event.
   *
   * @throws adopted_dispatch_unavailable — isLiveCarrierInvocation dep missing
   * @throws adopted_dispatch_not_live_carrier — invocation is not an active Live session
   * @throws a2a_dispatch_disposition_source_mismatch — source does not target this cat/thread
   */
  async completeAdopted(
    auth: A2ADispatchDispositionAuth,
    adoptedSourceMessageId: string,
    disposition: A2ADispatchDisposition,
  ): Promise<A2ADispatchDispositionResult> {
    if (this.deps.adoptionAuthority) {
      const attempt = () =>
        this.deps.adoptionAuthority!.run(auth, adoptedSourceMessageId, async (proof) => {
          await this.assertLatestInvocation(auth.invocationId);
          return this.completeReadSource(auth, adoptedSourceMessageId, disposition, proof);
        });
      try {
        return await attempt();
      } catch (error) {
        if (!(error instanceof A2ADispatchDispositionError) || error.code !== 'a2a_dispatch_disposition_fence_conflict')
          throw error;
        return attempt();
      }
    }
    const complete = (lease?: LiveCarrierOperationLease) =>
      this.completeAdoptedWithinCarrier(auth, adoptedSourceMessageId, disposition, lease);
    return this.deps.withLiveCarrierOperation ? this.deps.withLiveCarrierOperation(auth, complete) : complete();
  }

  private async completeAdoptedWithinCarrier(
    auth: A2ADispatchDispositionAuth,
    adoptedSourceMessageId: string,
    disposition: A2ADispatchDisposition,
    lease?: LiveCarrierOperationLease,
  ): Promise<A2ADispatchDispositionResult> {
    if (!this.deps.isLiveCarrierInvocation || !this.deps.getReadEvidenceForMessage) {
      throw new A2ADispatchDispositionError('adopted_dispatch_unavailable');
    }
    await this.assertLatestInvocation(auth.invocationId);
    // Host admission checked exact active credentials before close. Its scoped
    // proof survives draining, never another operation or an outer terminal.
    const isLive = lease
      ? lease.matches(auth)
      : await this.deps.isLiveCarrierInvocation({
          invocationId: auth.invocationId,
          catId: auth.catId,
          threadId: auth.threadId,
        });
    if (!isLive) {
      throw new A2ADispatchDispositionError('adopted_dispatch_not_live_carrier');
    }
    // Verify the Live carrier has durable, invocation-bound read-evidence for the
    // adopted dispatch message. Prevents completing dispatches that were never consumed.
    const readEvidence = await this.deps.getReadEvidenceForMessage({
      invocationId: auth.invocationId,
      catId: auth.catId,
      threadId: auth.threadId,
      messageId: adoptedSourceMessageId,
    });
    if (!readEvidence) {
      throw new A2ADispatchDispositionError('adopted_dispatch_not_read');
    }
    return this.completeReadSource(auth, adoptedSourceMessageId, disposition, {
      carrierKind: 'live',
      witness: readEvidence,
    });
  }

  async describe(auth: A2ADispatchDispositionAuth, messageIds: readonly string[]) {
    if (!this.deps.adoptionAuthority) return undefined;
    await this.assertLatestInvocation(auth.invocationId);
    const candidates = [];
    for (const sourceMessageId of await this.deps.adoptionAuthority.candidates(auth, messageIds)) {
      const source = await this.resolveSourceCoordinates({ ...auth, sourceMessageId });
      const events = await this.deps.ballCustodyEventLog.read(`ball:thread:${auth.threadId}`);
      if (findDispatchTerminal(events, { ...auth, sourceMessageId, fromCatId: source.fromCatId })) continue;
      if ((await this.inspectResolvedHandoff(auth.threadId, auth.catId, source, events)).outcome !== 'live') continue;
      candidates.push({
        sourceMessageId,
        tool: 'cat_cafe_complete_a2a_dispatch',
        arguments: { disposition: 'handled' as const, adoptSourceMessageId: sourceMessageId },
      });
    }
    return candidates.length
      ? {
          state: 'pending' as const,
          instruction:
            'Complete each exact source only after its requested work is handled. Reading alone is not completion.',
          candidates,
        }
      : undefined;
  }

  private async completeReadSource(
    auth: A2ADispatchDispositionAuth,
    adoptedSourceMessageId: string,
    disposition: A2ADispatchDisposition,
    proof: DispatchAdoptionProof,
  ): Promise<A2ADispatchDispositionResult> {
    const readEvidence = proof.witness;
    // Exact message match: evidence must cover the adopted dispatch source, not
    // any other message the invocation may have read.
    if (readEvidence.messageId !== adoptedSourceMessageId) {
      throw new A2ADispatchDispositionError('adopted_dispatch_not_read');
    }
    // Evidence kind whitelist: only durable, server-recorded full reads qualify.
    if (
      !(proof.carrierKind === 'ordinary'
        ? readEvidence.evidenceKind === 'queued_body_exposure'
        : ALLOWED_ADOPTED_EVIDENCE_KINDS.has(readEvidence.evidenceKind))
    ) {
      throw new A2ADispatchDispositionError('adopted_dispatch_evidence_kind_rejected');
    }
    // Temporal ordering: read evidence must be AFTER the ball.handed event that
    // created the dispatch. Prevents completing dispatches using stale reads
    // recorded before the handoff.
    const adoptionSubjectKey = `ball:thread:${auth.threadId}`;
    const handoffId = handedEventSourceId(adoptedSourceMessageId, auth.catId);
    const custodyEvents = await this.deps.ballCustodyEventLog.read(adoptionSubjectKey);
    const handoffEvent = custodyEvents.find((e) => e.sourceEventId === handoffId);
    if (!handoffEvent || !Number.isFinite(readEvidence.seenAt) || readEvidence.seenAt <= handoffEvent.at) {
      throw new A2ADispatchDispositionError('adopted_dispatch_evidence_before_handoff');
    }
    // Bypass Fence B (trigger identity check) — resolve source directly by
    // adopted message ID, still validating thread/cat targeting.
    const source = await this.resolveSourceCoordinates({
      threadId: auth.threadId,
      catId: auth.catId,
      sourceMessageId: adoptedSourceMessageId,
    });
    return this.completeResolved(
      auth,
      source,
      disposition,
      {
        adoptedSourceMessageId,
        ...(proof.carrierKind === 'ordinary'
          ? { carrierKind: 'ordinary' as const, invocationId: auth.invocationId }
          : { liveInvocationId: auth.invocationId }),
        witnessTimestamp: readEvidence.seenAt,
        readEvidenceKind: readEvidence.evidenceKind,
      },
      proof.assertSourceCurrent,
    );
  }

  private async completeResolved(
    auth: A2ADispatchDispositionAuth,
    source: DispatchSource,
    disposition: A2ADispatchDisposition,
    adopted?: DispatchDispositionEventInput['adopted'],
    assertSourceCurrent?: () => Promise<void>,
    via: NonNullable<DispatchDispositionEventInput['via']> = 'direct',
  ): Promise<A2ADispatchDispositionResult> {
    const subjectKey = `ball:thread:${auth.threadId}`;
    const events = await this.deps.ballCustodyEventLog.read(subjectKey);
    const eventSourceId = dispatchDispositionEventSourceId({
      invocationId: auth.invocationId,
      sourceMessageId: source.sourceMessageId,
    });
    const prior = adopted
      ? findDispatchTerminal(events, {
          threadId: auth.threadId,
          catId: auth.catId,
          sourceMessageId: source.sourceMessageId,
          fromCatId: source.fromCatId,
        })
      : events.find((event) => event.sourceEventId === eventSourceId);
    if (prior) {
      await assertSourceCurrent?.();
      const canonicalDisposition =
        adopted && prior.payload.invocationId !== auth.invocationId
          ? (prior.payload.disposition as A2ADispatchDisposition)
          : disposition;
      if (!adopted || prior.payload.invocationId === auth.invocationId)
        this.assertMatchingDispositionEvent(prior, auth, source, disposition);
      await this.repairProjectionIfNeeded(subjectKey, events, prior);
      // A canonical ordinary terminal is replayable, but its Queue settlement
      // remains ordinary; only an adopted terminal has a Live receipt to repair.
      if (adopted && prior.payload.adopted !== undefined)
        await this.deps.projectAdoptedDisposition?.({
          threadId: auth.threadId,
          catId: auth.catId,
          sourceMessageId: source.sourceMessageId,
        });
      return {
        outcome: 'replayed',
        disposition: canonicalDisposition,
        invocationId: auth.invocationId,
        sourceMessageId: source.sourceMessageId,
        fromCatId: source.fromCatId,
        retired: prior.payload.retired === true,
      };
    }

    const inspection = await this.inspectResolvedHandoff(auth.threadId, auth.catId, source, events);
    if (inspection.outcome === 'replaced') {
      throw new A2ADispatchDispositionError('a2a_dispatch_disposition_replaced', inspection.replacement);
    }
    const retired = await this.resolveRetired(subjectKey, auth.catId, source.handoffSourceEventId, events);
    if (assertSourceCurrent) {
      await this.assertLatestInvocation(auth.invocationId);
      await assertSourceCurrent();
    }
    await this.recordDisposition(
      auth,
      source,
      disposition,
      subjectKey,
      eventSourceId,
      events.length,
      retired,
      adopted,
      via,
    );
    const committed = (await this.deps.ballCustodyEventLog.read(subjectKey)).find(
      (event) => event.sourceEventId === eventSourceId,
    );
    this.assertMatchingDispositionEvent(committed, auth, source, disposition);
    if (adopted)
      await this.deps.projectAdoptedDisposition?.({
        threadId: auth.threadId,
        catId: auth.catId,
        sourceMessageId: source.sourceMessageId,
      });
    return {
      outcome: 'applied',
      disposition,
      invocationId: auth.invocationId,
      sourceMessageId: source.sourceMessageId,
      fromCatId: source.fromCatId,
      retired,
    };
  }

  /** Queue-start and callback completion share this exact source/event fence. */
  async inspectHandoff(input: {
    readonly threadId: string;
    readonly catId: string;
    readonly sourceMessageId: string;
  }): Promise<A2ADispatchHandoffInspection> {
    const source = await this.resolveSourceCoordinates(input);
    const events = await this.deps.ballCustodyEventLog.read(`ball:thread:${input.threadId}`);
    return this.inspectResolvedHandoff(input.threadId, input.catId, source, events);
  }

  private async assertLatestInvocation(invocationId: string): Promise<void> {
    if (!(await this.deps.registry.isLatest(invocationId))) {
      throw new A2ADispatchDispositionError('a2a_dispatch_disposition_stale_invocation');
    }
  }

  private async resolveSource(auth: A2ADispatchDispositionAuth): Promise<DispatchSource> {
    const sourceMessageId = auth.a2aTriggerMessageId;
    if (!sourceMessageId || auth.originTriggerMessageId !== sourceMessageId) {
      throw new A2ADispatchDispositionError('a2a_dispatch_disposition_source_missing');
    }
    return this.resolveSourceCoordinates({ threadId: auth.threadId, catId: auth.catId, sourceMessageId });
  }

  private async resolveSourceCoordinates(input: {
    readonly threadId: string;
    readonly catId: string;
    readonly sourceMessageId: string;
  }): Promise<DispatchSource> {
    const message = await this.deps.messageStore.getById(input.sourceMessageId);
    if (!this.isExactA2ASource(message, input)) {
      throw new A2ADispatchDispositionError('a2a_dispatch_disposition_source_mismatch');
    }
    const fromCatId = message.catId;
    return {
      sourceMessageId: input.sourceMessageId,
      fromCatId,
      handoffSourceEventId: handedEventSourceId(input.sourceMessageId, input.catId),
    };
  }

  private isExactA2ASource(
    message: StoredMessage | null,
    auth: { readonly threadId: string; readonly catId: string },
  ): message is StoredMessage & { catId: NonNullable<StoredMessage['catId']> } {
    return Boolean(
      message &&
        message.threadId === auth.threadId &&
        message.catId &&
        (message.catId !== auth.catId ||
          isCrossThreadProvenance(message.extra?.crossPost?.sourceThreadId, message.threadId)) &&
        this.messageTargetsCat(message, auth.catId),
    );
  }

  private messageTargetsCat(message: StoredMessage, catId: string): boolean {
    if (message.mentions.some((candidate) => candidate === catId)) return true;
    return Boolean(message.extra?.targetCats?.includes(catId));
  }

  private async resolveRetired(
    subjectKey: string,
    catId: string,
    handoffSourceEventId: string,
    events: readonly BallCustodyEvent[],
  ): Promise<boolean> {
    let projection = await this.deps.ballCustodyProjectionStore.get(subjectKey);
    if (!projection && this.deps.repairProjection) {
      await this.deps.repairProjection(subjectKey);
      projection = await this.deps.ballCustodyProjectionStore.get(subjectKey);
    }
    if (!projection) {
      throw new A2ADispatchDispositionError('a2a_dispatch_disposition_holder_mismatch');
    }
    const handoffIndex = events.findIndex((event) => event.sourceEventId === handoffSourceEventId);
    const acquiredAfterDispatch = events
      .slice(handoffIndex + 1)
      .some((event) => event.kind === 'ball.handed' || event.kind === 'ball.held');
    return (
      acquiredAfterDispatch ||
      (projection.state !== 'active' && projection.state !== 'blocked') ||
      projection.holder !== catId
    );
  }

  private async inspectResolvedHandoff(
    threadId: string,
    catId: string,
    source: DispatchSource,
    events: readonly BallCustodyEvent[],
  ): Promise<A2ADispatchHandoffInspection> {
    const inspection = await resolveA2ADispatchHandoff({
      threadId,
      catId,
      source,
      events,
      messageStore: this.deps.messageStore,
      ...(this.deps.log ? { log: this.deps.log } : {}),
    });
    if (inspection.outcome === 'missing') {
      throw new A2ADispatchDispositionError('a2a_dispatch_disposition_handoff_missing');
    }
    return inspection;
  }

  private assertMatchingDispositionEvent(
    event: BallCustodyEvent | undefined,
    auth: A2ADispatchDispositionAuth,
    source: DispatchSource,
    disposition: A2ADispatchDisposition,
  ): void {
    if (
      !event ||
      event.kind !== 'ball.dispatch_dispositioned' ||
      event.payload.catId !== auth.catId ||
      event.payload.fromCatId !== source.fromCatId ||
      event.payload.invocationId !== auth.invocationId ||
      event.payload.sourceMessageId !== source.sourceMessageId ||
      event.payload.disposition !== disposition
    ) {
      throw dispatchReplayMismatch(event);
    }
  }

  private async recordDisposition(
    auth: A2ADispatchDispositionAuth,
    source: DispatchSource,
    disposition: A2ADispatchDisposition,
    subjectKey: string,
    eventSourceId: string,
    expectedSequence: number,
    retired: boolean,
    adopted?: DispatchDispositionEventInput['adopted'],
    via: NonNullable<DispatchDispositionEventInput['via']> = 'direct',
  ): Promise<void> {
    let conflictSequence: number | undefined;
    try {
      const result = await this.deps.ballCustody.recordFenced(
        buildDispatchDispositionEvent({
          threadId: auth.threadId,
          catId: auth.catId,
          fromCatId: source.fromCatId,
          invocationId: auth.invocationId,
          sourceMessageId: source.sourceMessageId,
          disposition,
          retired,
          via,
          at: this.now(),
          ...(adopted ? { adopted } : {}),
        }),
        expectedSequence,
      );
      if (result.outcome === 'conflict') {
        conflictSequence = result.actualSequence;
        throw new A2ADispatchDispositionError('a2a_dispatch_disposition_fence_conflict');
      }
    } catch (error) {
      const events = await this.deps.ballCustodyEventLog.read(subjectKey);
      if (conflictSequence !== undefined) {
        this.deps.log?.warn(
          {
            threadId: auth.threadId,
            invocationId: auth.invocationId,
            sourceMessageId: source.sourceMessageId,
            expectedSequence,
            actualSequence: conflictSequence,
            interveningEvents: events
              .slice(expectedSequence, Math.min(conflictSequence, expectedSequence + 8))
              .map(({ sourceEventId, kind, at }) => ({ sourceEventId, kind, at })),
            omittedEventCount: Math.max(0, conflictSequence - expectedSequence - 8),
          },
          '[F167] A2A dispatch disposition CAS conflict',
        );
      }
      const appended = events.find((event) => event.sourceEventId === eventSourceId);
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
    // An inert retirement never promises a resolved thread. Rebuilding a healthy
    // active/parked projection on every recovery pass would rewrite unrelated work.
    const rejectedDisposition = projection?.lastRejectedEvent?.sourceEventId === dispositionEvent.sourceEventId;
    if (
      !projection ||
      rejectedDisposition ||
      (dispositionEvent.payload.retired !== true && !reopenedAfterDisposition && projection.state !== 'resolved')
    ) {
      await this.deps.repairProjection(subjectKey);
    }
  }
}
