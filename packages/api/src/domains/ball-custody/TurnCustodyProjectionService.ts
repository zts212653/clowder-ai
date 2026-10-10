import type { ActionSuccessorLeaseStore } from './ActionSuccessorLeaseStore.js';
import type { ActionSuccessorLease } from './action-successor-state-machine.js';

// Public vocabulary re-exported so the seven existing importers stay untouched.
export type {
  ActionTransitionBaseline,
  TurnCustodyProjection,
  TurnCustodyProjectionState,
  TurnCustodyShadowComparison,
  TurnCustodyStopDecision,
  TurnCustodyWakeProvenance,
} from './turn-custody-projection-types.js';

// Only what this file's body actually references.
import type {
  ActionTransitionBaseline,
  TurnCustodyProjection,
  TurnCustodyShadowComparison,
  TurnCustodyStopDecision,
  TurnCustodyWakeProvenance,
} from './turn-custody-projection-types.js';

interface TurnCustodyProjectionDeps {
  readonly actionSuccessorLeaseStore?: Pick<ActionSuccessorLeaseStore, 'get'>;
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
    if (wake.kind === 'structured') {
      return { state: 'covered_empty', evidenceRefs: [`lifecycle:${wake.protocol}`] };
    }
    if (wake.kind === 'legacy') return unknown(wake.reason);
    try {
      return await this.openAction(wake);
    } catch {
      return unknown('query_failed');
    }
  }

  async close(projection: TurnCustodyProjection): Promise<TurnCustodyStopDecision> {
    if (!projection.baseline) return decision(projection, false);
    try {
      return decision(projection, await this.actionTransitionObserved(projection.baseline));
    } catch {
      const evidenceRefs = [...projection.evidenceRefs, 'unknown:query_failed'];
      // A covered-empty projection already proved that the predecessor is not
      // a live obligation. A transient observation failure may withhold its
      // continuation witness, but must not revive that obligation.
      if (projection.state === 'covered_empty') {
        return decision({ ...projection, evidenceRefs }, false);
      }
      return decision({ state: 'unknown_legacy', evidenceRefs }, false, 'unknown_legacy');
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

  private async actionTransitionObserved(baseline: ActionTransitionBaseline): Promise<boolean> {
    const lease = await this.deps.actionSuccessorLeaseStore?.get(baseline.leaseId);
    if (!lease) return false;
    return actionTransitionFingerprint(lease, baseline.holderCatId) !== baseline.fingerprint;
  }
}
