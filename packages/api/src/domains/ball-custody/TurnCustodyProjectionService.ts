import type { BallCustodyEvent } from '@cat-cafe/shared';
import type { ActionSuccessorLeaseStore } from './ActionSuccessorLeaseStore.js';
import type { ActionSuccessorLease } from './action-successor-state-machine.js';
import type { IBallCustodyEventLog } from './BallCustodyEventLog.js';
import type { IBallCustodyProjectionStore } from './BallCustodyProjectionStore.js';

export type TurnCustodyWakeProvenance =
  | {
      readonly kind: 'unstructured';
      readonly source: 'user_chat' | 'roam' | 'cron' | 'brainstorm' | 'protocol_decline';
    }
  | {
      readonly kind: 'non_obligation';
      readonly source: 'cross_thread_fyi' | 'cross_thread_coordinate' | 'coordination_terminal';
    }
  | {
      readonly kind: 'action_successor';
      readonly leaseId: string;
      readonly generation: number;
      readonly holderCatId: string;
    }
  | {
      readonly kind: 'structured';
      readonly protocol: 'hold' | 'event_wait' | 'assign_work' | 'coordination' | 'callback';
      readonly subjectKey: string;
      readonly holderCatId: string;
    }
  | {
      readonly kind: 'structured';
      readonly protocol: 'dispatch';
      readonly subjectKey: string;
      readonly holderCatId: string;
      readonly handoff: {
        readonly sourceEventId: string;
        readonly messageId: string;
        readonly fromCatId: string;
      };
    }
  | {
      readonly kind: 'legacy';
      readonly reason: 'text_mention' | 'source_missing' | 'carrier_missing' | 'query_failed';
      readonly sourceCategory?: string;
    };

export type TurnCustodyProjectionState = 'covered_active' | 'covered_empty' | 'unknown_legacy';

interface ActionTransitionBaseline {
  readonly kind: 'action_successor';
  readonly leaseId: string;
  readonly generation: number;
  readonly holderCatId: string;
  readonly fingerprint: string;
}

interface StructuredTransitionBaseline {
  readonly kind: 'structured';
  readonly subjectKey: string;
  readonly holderCatId: string;
  readonly fromSequence: number;
}

export interface TurnCustodyProjection {
  readonly state: TurnCustodyProjectionState;
  readonly evidenceRefs: readonly string[];
  readonly baseline?: ActionTransitionBaseline | StructuredTransitionBaseline;
}

export interface TurnCustodyStopDecision {
  readonly state: TurnCustodyProjectionState;
  readonly shouldBlock: boolean;
  readonly transitionObserved: boolean;
  readonly evidenceRefs: string[];
}

export type TurnCustodyShadowComparison = 'agree_allow' | 'agree_block' | 'old_only_block' | 'new_only_block';

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

function unknown(reason: string): TurnCustodyProjection {
  return { state: 'unknown_legacy', evidenceRefs: [`unknown:${reason}`] };
}

function decision(
  projection: TurnCustodyProjection,
  transitionObserved: boolean,
  state = projection.state,
): TurnCustodyStopDecision {
  return {
    state,
    shouldBlock: state === 'unknown_legacy' || (state === 'covered_active' && !transitionObserved),
    transitionObserved,
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
      const observed =
        projection.baseline.kind === 'action_successor'
          ? await this.actionTransitionObserved(projection.baseline)
          : await this.structuredTransitionObserved(projection.baseline);
      return decision(projection, observed);
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
    if (projection?.state !== 'active' && projection?.state !== 'blocked') {
      return unknown('structured_projection_missing');
    }
    if (projection.holder !== wake.holderCatId) return unknown('structured_holder_mismatch');
    if (
      wake.protocol === 'dispatch' &&
      !events.some(
        (event) =>
          event.kind === 'ball.handed' &&
          event.sourceEventId === wake.handoff.sourceEventId &&
          event.payload.fromCatId === wake.handoff.fromCatId &&
          event.payload.toCatId === wake.holderCatId,
      )
    ) {
      return unknown('dispatch_handoff_missing');
    }
    return {
      state: 'covered_active',
      evidenceRefs: [
        `${wake.protocol}:${wake.subjectKey}`,
        ...(wake.protocol === 'dispatch' ? [wake.handoff.sourceEventId] : []),
      ],
      baseline: {
        kind: 'structured',
        subjectKey: wake.subjectKey,
        holderCatId: wake.holderCatId,
        fromSequence: events.length,
      },
    };
  }

  private async actionTransitionObserved(baseline: ActionTransitionBaseline): Promise<boolean> {
    const lease = await this.deps.actionSuccessorLeaseStore?.get(baseline.leaseId);
    if (!lease) return false;
    return actionTransitionFingerprint(lease, baseline.holderCatId) !== baseline.fingerprint;
  }

  private async structuredTransitionObserved(baseline: StructuredTransitionBaseline): Promise<boolean> {
    const events = await this.deps.ballCustodyEventLog?.read(baseline.subjectKey, baseline.fromSequence);
    return events?.some((event) => this.isLegitimateStructuredTransition(event, baseline.holderCatId)) ?? false;
  }

  private isLegitimateStructuredTransition(event: BallCustodyEvent, holderCatId: string): boolean {
    if (event.kind === 'ball.handed' || event.kind === 'ball.handed_cvo') {
      return event.payload.fromCatId === holderCatId;
    }
    if (event.kind === 'ball.held') return event.payload.catId === holderCatId;
    return false;
  }
}
