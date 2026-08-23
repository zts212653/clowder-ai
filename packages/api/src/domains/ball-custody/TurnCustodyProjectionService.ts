import type { BallCustodyEvent } from '@cat-cafe/shared';
import type { ActionSuccessorLeaseStore } from './ActionSuccessorLeaseStore.js';
import type { ActionSuccessorLease } from './action-successor-state-machine.js';
import type { IBallCustodyEventLog } from './BallCustodyEventLog.js';
import type { IBallCustodyProjectionStore } from './BallCustodyProjectionStore.js';
import {
  exactStructuredWakeIndex,
  findWakeTerminal,
  releasedStructuredWake,
  supersededBeforeAdoption,
} from './managed-hold-supersession.js';

// Public vocabulary re-exported so the seven existing importers stay untouched.
export type {
  ActionTransitionBaseline,
  StructuredTransitionBaseline,
  StructuredTransitionObservation,
  TurnCustodyProjection,
  TurnCustodyProjectionState,
  TurnCustodyShadowComparison,
  TurnCustodyStopDecision,
  TurnCustodyWakeProvenance,
} from './turn-custody-projection-types.js';

// Only what this file's body actually references.
import type {
  ActionTransitionBaseline,
  StructuredTransitionBaseline,
  StructuredTransitionObservation,
  TurnCustodyProjection,
  TurnCustodyShadowComparison,
  TurnCustodyStopDecision,
  TurnCustodyWakeProvenance,
} from './turn-custody-projection-types.js';

interface TurnCustodyProjectionDeps {
  readonly actionSuccessorLeaseStore?: Pick<ActionSuccessorLeaseStore, 'get'>;
  readonly ballCustodyProjectionStore?: Pick<IBallCustodyProjectionStore, 'get'>;
  readonly ballCustodyEventLog?: Pick<IBallCustodyEventLog, 'read'>;
}

function candidateFingerprint(lease: ActionSuccessorLease, holderCatId: string): unknown {
  const candidate = lease.completionCandidates[holderCatId];
  return candidate
    ? { candidateRevision: candidate.candidateRevision, evidenceDigest: candidate.evidenceDigest }
    : null;
}

function actionTransitionFingerprint(lease: ActionSuccessorLease, holderCatId: string): string {
  return JSON.stringify({
    generation: lease.generation,
    status: lease.status,
    holderCatIds: [...lease.holderCatIds].sort(),
    holderOutcome: lease.holderOutcomes[holderCatId] ?? null,
    completionCandidate: candidateFingerprint(lease, holderCatId),
    returnTransitions: lease.returnTransitions,
  });
}

function dispatchTransitionObservation(
  event: BallCustodyEvent,
  baseline: StructuredTransitionBaseline,
): StructuredTransitionObservation | undefined {
  if (
    baseline.protocol !== 'dispatch' ||
    event.payload.catId !== baseline.holderCatId ||
    event.payload.sourceMessageId !== baseline.dispatchSourceMessageId ||
    event.payload.fromCatId !== baseline.dispatchFromCatId
  ) {
    return undefined;
  }
  const disposition = event.payload.disposition;
  return {
    structuredTransitionKind: 'dispatch_dispositioned',
    ...(disposition === 'handled' || disposition === 'completed'
      ? {
          dispatchDisposition: disposition,
          dispatchDispositionEventId: event.sourceEventId,
          dispatchDispositionAt: event.at,
        }
      : {}),
  };
}

function unknown(reason: string): TurnCustodyProjection {
  return { state: 'unknown_legacy', evidenceRefs: [`unknown:${reason}`] };
}

function decision(
  projection: TurnCustodyProjection,
  transitionObserved: boolean,
  state = projection.state,
  structuredTransition?: StructuredTransitionObservation,
): TurnCustodyStopDecision {
  return {
    state,
    shouldBlock: state === 'unknown_legacy' || (state === 'covered_active' && !transitionObserved),
    transitionObserved,
    ...structuredTransition,
    evidenceRefs: [...projection.evidenceRefs],
  };
}

export function compareTurnCustodyShadow(oldBlock: boolean, newBlock: boolean): TurnCustodyShadowComparison {
  if (oldBlock && newBlock) return 'agree_block';
  if (!oldBlock && !newBlock) return 'agree_allow';
  return oldBlock ? 'old_only_block' : 'new_only_block';
}

export class TurnCustodyProjectionService {
  constructor(private readonly deps: TurnCustodyProjectionDeps) {}

  async open(wake: TurnCustodyWakeProvenance): Promise<TurnCustodyProjection> {
    if (wake.kind === 'unstructured' || wake.kind === 'non_obligation') {
      return { state: 'covered_empty', evidenceRefs: [`wake:${wake.source}`] };
    }
    if (wake.kind === 'legacy') return unknown(wake.reason);
    try {
      return wake.kind === 'action_successor' ? await this.openAction(wake) : await this.openStructured(wake);
    } catch {
      return unknown('query_failed');
    }
  }

  async close(projection: TurnCustodyProjection): Promise<TurnCustodyStopDecision> {
    if (projection.state !== 'covered_active' || !projection.baseline) return decision(projection, false);
    try {
      if (projection.baseline.kind === 'action_successor') {
        return decision(projection, await this.actionTransitionObserved(projection.baseline));
      }
      const structuredTransition = await this.structuredTransitionObserved(projection.baseline);
      return decision(projection, structuredTransition !== undefined, projection.state, structuredTransition);
    } catch {
      return decision(
        { state: 'unknown_legacy', evidenceRefs: [...projection.evidenceRefs, 'unknown:query_failed'] },
        false,
        'unknown_legacy',
      );
    }
  }

  private async openAction(
    wake: Extract<TurnCustodyWakeProvenance, { kind: 'action_successor' }>,
  ): Promise<TurnCustodyProjection> {
    if (!this.deps.actionSuccessorLeaseStore) return unknown('action_store_unavailable');
    const lease = await this.deps.actionSuccessorLeaseStore.get(wake.leaseId);
    if (!lease) return unknown('action_lease_missing');
    if (lease.generation !== wake.generation) return unknown('action_generation_mismatch');
    if (lease.status !== 'active') return unknown('action_terminal');
    if (!lease.holderCatIds.includes(wake.holderCatId)) return unknown('action_holder_mismatch');
    return {
      state: 'covered_active',
      evidenceRefs: [`action:${wake.leaseId}:g${wake.generation}:${wake.holderCatId}`],
      baseline: {
        kind: 'action_successor',
        leaseId: wake.leaseId,
        generation: wake.generation,
        holderCatId: wake.holderCatId,
        fingerprint: actionTransitionFingerprint(lease, wake.holderCatId),
      },
    };
  }

  private async openStructured(
    wake: Extract<TurnCustodyWakeProvenance, { kind: 'structured' }>,
  ): Promise<TurnCustodyProjection> {
    if (!this.deps.ballCustodyProjectionStore || !this.deps.ballCustodyEventLog) {
      return unknown('structured_store_unavailable');
    }
    const [projection, events] = await Promise.all([
      this.deps.ballCustodyProjectionStore.get(wake.subjectKey),
      this.deps.ballCustodyEventLog.read(wake.subjectKey),
    ]);
    // Sol R3 P1: a non-retired terminal drives the subject to `resolved`. If the
    // F264 receipt then fails and Queue re-exposes the same wake, the successor
    // route would bail to unknown_legacy here and write
    // `managed_hold_disposition_missing` even though the wake is already settled.
    // Per-wake terminal truth is checked before subject-level state.
    if (wake.protocol === 'hold') {
      const settled = findWakeTerminal(events, {
        catId: wake.holderCatId,
        sourceMessageId: wake.sourceMessageId,
        taskId: wake.taskId,
      });
      if (settled) {
        return {
          state: 'covered_empty',
          evidenceRefs: [`${wake.protocol}:${wake.subjectKey}`, `settled:${settled.sourceEventId}`],
        };
      }
    }
    if (projection?.state !== 'active' && projection?.state !== 'blocked') {
      return unknown('structured_projection_missing');
    }
    const exactWakeIndex = exactStructuredWakeIndex(wake, events);
    if (wake.protocol === 'dispatch' && exactWakeIndex === -1) {
      return unknown('dispatch_handoff_missing');
    }
    if (projection.holder !== wake.holderCatId) {
      return releasedStructuredWake(wake, events, exactWakeIndex) ?? unknown('structured_holder_mismatch');
    }
    // clowder-ai#1366: a wake superseded before this turn adopted it is not a
    // live obligation; treating it as one blocked unrelated healthy turns.
    if (wake.protocol === 'hold') {
      const superseded = supersededBeforeAdoption(
        events,
        { catId: wake.holderCatId, sourceMessageId: wake.sourceMessageId, taskId: wake.taskId },
        wake.subjectKey,
      );
      if (superseded) return { state: 'covered_empty', evidenceRefs: [...superseded] };
    }
    return this.coveredActiveProjection(wake, events);
  }

  /** Live obligation plus the exact baseline `close()` will diff its transition against. */
  private coveredActiveProjection(
    wake: Extract<TurnCustodyWakeProvenance, { kind: 'structured' }>,
    events: readonly BallCustodyEvent[],
  ): TurnCustodyProjection {
    return {
      state: 'covered_active',
      evidenceRefs: [
        `${wake.protocol}:${wake.subjectKey}`,
        ...(wake.protocol === 'event_wait'
          ? [
              `wait:${wake.waitContinuationCarrier.waitId}:${wake.waitContinuationCarrier.outcomeId}:g${wake.waitContinuationCarrier.ownerFence.generation}`,
            ]
          : []),
        ...(wake.protocol === 'dispatch' ? [wake.handoff.sourceEventId] : []),
      ],
      baseline: {
        kind: 'structured',
        subjectKey: wake.subjectKey,
        holderCatId: wake.holderCatId,
        fromSequence: events.length,
        protocol: wake.protocol,
        ...(wake.protocol === 'hold' ? { sourceMessageId: wake.sourceMessageId, taskId: wake.taskId } : {}),
        ...(wake.protocol === 'dispatch'
          ? {
              dispatchSourceMessageId: wake.handoff.messageId,
              dispatchFromCatId: wake.handoff.fromCatId,
            }
          : {}),
      },
    };
  }

  private async actionTransitionObserved(baseline: ActionTransitionBaseline): Promise<boolean> {
    const lease = await this.deps.actionSuccessorLeaseStore?.get(baseline.leaseId);
    if (!lease) return false;
    return actionTransitionFingerprint(lease, baseline.holderCatId) !== baseline.fingerprint;
  }

  private async structuredTransitionObserved(
    baseline: StructuredTransitionBaseline,
  ): Promise<StructuredTransitionObservation | undefined> {
    const events = await this.deps.ballCustodyEventLog?.read(baseline.subjectKey, baseline.fromSequence);
    for (const event of events ?? []) {
      const kind = this.structuredTransitionKind(event, baseline);
      if (kind) return kind;
    }
    return undefined;
  }

  private structuredTransitionKind(
    event: BallCustodyEvent,
    baseline: StructuredTransitionBaseline,
  ): StructuredTransitionObservation | undefined {
    const holderCatId = baseline.holderCatId;
    if (event.kind === 'ball.hold_dispositioned') {
      return baseline.protocol === 'hold' &&
        event.payload.catId === holderCatId &&
        event.payload.sourceMessageId === baseline.sourceMessageId &&
        event.payload.taskId === baseline.taskId
        ? { structuredTransitionKind: 'hold_dispositioned' }
        : undefined;
    }
    if (event.kind === 'ball.dispatch_dispositioned') {
      return dispatchTransitionObservation(event, baseline);
    }
    if (event.kind === 'ball.handed' || event.kind === 'ball.handed_cvo') {
      return event.payload.fromCatId === holderCatId ? { structuredTransitionKind: 'handed' } : undefined;
    }
    if (event.kind === 'ball.held') {
      return event.payload.catId === holderCatId ? { structuredTransitionKind: 'held' } : undefined;
    }
    return undefined;
  }
}
