import type { WaitContinuationCarrierV1 } from '@cat-cafe/shared';

/**
 * Turn-custody projection vocabulary.
 *
 * Split out of TurnCustodyProjectionService so that file stays inside the repo's
 * 350-line hard cap (Sol REQUEST_CHANGES P2). Declarations only — no behaviour
 * moved. TurnCustodyProjectionService re-exports these, so existing importers
 * are unaffected.
 */
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
      readonly protocol: 'event_wait';
      readonly subjectKey: string;
      readonly holderCatId: string;
      readonly waitContinuationCarrier: WaitContinuationCarrierV1;
    }
  | {
      readonly kind: 'structured';
      readonly protocol: 'assign_work' | 'coordination' | 'callback';
      readonly subjectKey: string;
      readonly holderCatId: string;
    }
  | {
      readonly kind: 'structured';
      readonly protocol: 'hold';
      readonly subjectKey: string;
      readonly holderCatId: string;
      readonly sourceMessageId: string;
      readonly taskId: string;
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

export interface ActionTransitionBaseline {
  readonly kind: 'action_successor';
  readonly leaseId: string;
  readonly generation: number;
  readonly holderCatId: string;
  readonly fingerprint: string;
}

export interface StructuredTransitionBaseline {
  readonly kind: 'structured';
  readonly subjectKey: string;
  readonly holderCatId: string;
  readonly fromSequence: number;
  readonly protocol: Extract<TurnCustodyWakeProvenance, { kind: 'structured' }>['protocol'];
  readonly sourceMessageId?: string;
  readonly taskId?: string;
  readonly dispatchSourceMessageId?: string;
  readonly dispatchFromCatId?: string;
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
  readonly structuredTransitionKind?: 'hold_dispositioned' | 'dispatch_dispositioned' | 'held' | 'handed';
  readonly dispatchDisposition?: 'handled' | 'completed';
  readonly dispatchDispositionEventId?: string;
  readonly dispatchDispositionAt?: number;
  readonly evidenceRefs: string[];
}

export type StructuredTransitionObservation = Pick<
  TurnCustodyStopDecision,
  'structuredTransitionKind' | 'dispatchDisposition' | 'dispatchDispositionEventId' | 'dispatchDispositionAt'
>;

export type TurnCustodyShadowComparison = 'agree_allow' | 'agree_block' | 'old_only_block' | 'new_only_block';
