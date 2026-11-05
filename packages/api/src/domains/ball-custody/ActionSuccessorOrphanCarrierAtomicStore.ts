import type { LifecycleStoredMessageMetadata, TaskItem } from '@cat-cafe/shared';
import type { QueueLedgerEntry } from '../cats/services/agents/invocation/queue-ledger/QueueLedger.js';
import type { StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import type { OrphanCarrierSourceIdentity } from './action-successor-orphan-carrier-source.js';
import type { ActionSuccessorLease } from './action-successor-state-machine.js';

export interface ActionSuccessorOrphanCarrierAtomicCommitInput {
  readonly expectedLease: ActionSuccessorLease;
  readonly nextLease: ActionSuccessorLease;
  readonly task: TaskItem;
  readonly source: StoredMessage;
  readonly sourceIdentity: OrphanCarrierSourceIdentity;
  readonly sourceLifecycle: LifecycleStoredMessageMetadata;
  readonly entry: QueueLedgerEntry;
  readonly canonicalInvocationKey: string;
  readonly legacyInvocationKey: string;
}

export type ActionSuccessorOrphanCarrierAtomicCommitResult =
  | { readonly outcome: 'committed'; readonly lease: ActionSuccessorLease }
  | { readonly outcome: 'replayed'; readonly lease: ActionSuccessorLease }
  | { readonly outcome: 'stale'; readonly lease: ActionSuccessorLease }
  | {
      readonly outcome: 'rejected';
      readonly reason:
        | 'subject_terminal'
        | 'identity_mismatch'
        | 'task_changed'
        | 'source_changed'
        | 'carrier_state_present'
        | 'execution_present'
        | 'store_corrupt';
    };

/** One commit owner for the existing ActionSuccessor + Task + Message + Queue records. */
export interface ActionSuccessorOrphanCarrierAtomicStore {
  commit(input: ActionSuccessorOrphanCarrierAtomicCommitInput): Promise<ActionSuccessorOrphanCarrierAtomicCommitResult>;
}
