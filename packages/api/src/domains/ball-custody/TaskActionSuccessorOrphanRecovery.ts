import type { TaskItem } from '@cat-cafe/shared';
import { createModuleLogger } from '../../infrastructure/logger.js';
import {
  actionSuccessorCarrierKey,
  actionSuccessorInvocationIdempotencyKey,
  actionSuccessorInvocationKeyForTarget,
} from '../cats/services/agents/invocation/InvocationQueue.js';
import type { QueueLedgerEntry } from '../cats/services/agents/invocation/queue-ledger/QueueLedger.js';
import { createQueueLedgerAdmission } from '../cats/services/agents/invocation/queue-ledger/QueueLedgerAdmission.js';
import type { OwnerAuthProvenance } from '../cats/services/owner-auth-provenance.js';
import type { IInvocationRecordStore } from '../cats/services/stores/ports/InvocationRecordStore.js';
import {
  type IMessageStore,
  prepareQueueLedgerSourceLifecycle,
  type StoredMessage,
} from '../cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../cats/services/stores/ports/TaskStore.js';
import type { ITurnExecutionStore } from '../cats/services/stores/ports/TurnExecutionStore.js';
import { resolveTaskExecutionBinding } from '../growing/EntrustedWorkTaskExecutionBinding.js';
import {
  type ActionSuccessorAdmissionInput,
  actionSuccessorFencesMatch,
  buildActionSuccessorFence,
} from './ActionSuccessorAdmissionContract.js';
import type {
  ActionSuccessorOrphanCarrierAtomicCommitResult,
  ActionSuccessorOrphanCarrierAtomicStore,
} from './ActionSuccessorOrphanCarrierAtomicStore.js';
import type { TaskApprovedDelegateProvider } from './action-subject-delegate-contract.js';
import { isExactOrphanRecoveryEntry } from './action-successor-orphan-carrier-replay.js';
import { resolveOrphanCarrierSource } from './action-successor-orphan-carrier-source.js';
import {
  type ActionSuccessorLease,
  currentOrphanCarrierRecovery,
  recoverOrphanActionSuccessorCarrier,
} from './action-successor-state-machine.js';
import { isExactDirectActionSuccessorReentry } from './DirectActionSuccessorCarrierRecovery.js';

const log = createModuleLogger('ball-custody/task-action-successor-orphan-recovery');
type ExecutionReadStage = 'queue_ledger' | 'invocation_records' | 'turn_executions';

export interface TaskActionSuccessorOrphanRecoveryDeps {
  readonly logger?: Pick<typeof log, 'warn'>;
  readonly tasks: Pick<ITaskStore, 'get'>;
  readonly messages: Pick<IMessageStore, 'getByIdempotencyKey' | 'getByThreadBeforeBounded'>;
  readonly queue: {
    listAllDurable(threadId: string): Promise<QueueLedgerEntry[]>;
    adoptCommittedAdmission(entries: readonly QueueLedgerEntry[], message: StoredMessage): Promise<unknown>;
  };
  readonly invocationRecords: IInvocationRecordStore;
  readonly turnExecutions: Pick<ITurnExecutionStore, 'listBySource'>;
  readonly delegates: TaskApprovedDelegateProvider;
  readonly atomicStore: ActionSuccessorOrphanCarrierAtomicStore;
}

export type TaskActionSuccessorOrphanRecoveryResult =
  | { readonly outcome: 'recovered' | 'replayed'; readonly lease: ActionSuccessorLease; readonly messageId: string }
  | { readonly outcome: 'superseded'; readonly lease: ActionSuccessorLease }
  | { readonly outcome: 'refused'; readonly reason: string };

type TaskAuthority =
  | {
      readonly ok: true;
      readonly task: TaskItem;
      readonly entrusted: NonNullable<TaskItem['entrustedWork']>;
      readonly holderCatId: string;
      readonly predecessorCatId: string;
    }
  | { readonly ok: false; readonly reason: string };

export class TaskActionSuccessorOrphanRecovery {
  constructor(private readonly deps: TaskActionSuccessorOrphanRecoveryDeps) {}

  async recover(input: {
    lease: ActionSuccessorLease;
    admissionInput: ActionSuccessorAdmissionInput;
    ownerAuthProvenance: OwnerAuthProvenance;
    parentInvocationId?: string;
  }): Promise<TaskActionSuccessorOrphanRecoveryResult> {
    const { lease, admissionInput } = input;
    if (!isExactDirectActionSuccessorReentry(lease, admissionInput)) return refused('authority_mismatch');
    const taskId = taskIdFromLease(lease);
    if (!taskId) return refused('not_task_implement');

    const authority = await this.resolveTaskAuthority(taskId, lease);
    if (!authority.ok) return refused(authority.reason);
    const { task, entrusted, holderCatId, predecessorCatId } = authority;

    const currentRecovery = currentOrphanCarrierRecovery(lease);
    if (currentRecovery && admissionInput.dispatchId === lease.dispatchId) {
      return this.adoptCurrentRecovery(lease, currentRecovery);
    }

    const sourceResolution = await resolveOrphanCarrierSource(this.deps.messages, lease, {
      dispatchId: lease.dispatchId,
      lifecycle: 'unbound',
    });
    if (!sourceResolution.ok) return refused(sourceResolution.reason);
    const { source, identity: sourceIdentity } = sourceResolution;
    const executionBlocker = await this.carrierOrExecutionBlocker(lease, source);
    if (executionBlocker) return refused(executionBlocker);

    const transition = recoverOrphanActionSuccessorCarrier(lease, {
      expectedGeneration: lease.generation,
      expectedRevision: lease.revision,
      taskId,
      taskRevision: entrusted.revision,
      sourceMessageId: source.id,
      predecessorCatId: admissionInput.actorCatId,
      predecessorThreadId: admissionInput.sourceThreadId,
      holderCatId,
      holderThreadId: admissionInput.targetThreadId,
      dispatchId: admissionInput.dispatchId,
      evidenceRef: admissionInput.evidenceRef,
      now: admissionInput.now,
    });
    if (transition.outcome !== 'recovered') return refused(transition.outcome);
    const nextLease = transition.lease;
    const nextFence = buildActionSuccessorFence(nextLease, nextLease.dispatchId);
    const [entry] = createQueueLedgerAdmission({
      sourceId: source.id,
      threadId: lease.holderThreadId,
      owner: { kind: 'user', userId: lease.tenantScope },
      kind: 'message_wake',
      from: { kind: 'agent', catId: predecessorCatId },
      targetCatIds: [holderCatId],
      requestedTargetCats: [holderCatId],
      content: source.content,
      messageId: source.id,
      intent: 'execute',
      ownerAuthProvenance: input.ownerAuthProvenance,
      autoExecute: true,
      sourceCategory: 'a2a',
      a2aParentInvocationId: input.parentInvocationId,
      actionSuccessorFence: nextFence,
      a2aTriggerMessageId: source.id,
      enqueuedAt: admissionInput.now,
    });
    if (!entry) return refused('carrier_prepare_failed');
    const sourceLifecycle = prepareQueueLedgerSourceLifecycle(source, [entry]);
    const oldFence = buildActionSuccessorFence(lease, lease.dispatchId);
    let committed: ActionSuccessorOrphanCarrierAtomicCommitResult;
    try {
      committed = await this.deps.atomicStore.commit({
        expectedLease: lease,
        nextLease,
        task,
        source,
        sourceIdentity,
        sourceLifecycle,
        entry,
        canonicalInvocationKey: actionSuccessorInvocationKeyForTarget(source.id, holderCatId),
        legacyInvocationKey: actionSuccessorInvocationIdempotencyKey(actionSuccessorCarrierKey(oldFence, holderCatId)),
      });
    } catch {
      return refused('store_unreadable');
    }
    if (committed.outcome === 'stale') return { outcome: 'superseded', lease: committed.lease };
    if (committed.outcome === 'rejected') return refused(committed.reason);

    const persistedSource = { ...source, lifecycle: sourceLifecycle };
    await this.deps.queue.adoptCommittedAdmission([entry], persistedSource);
    return {
      outcome: committed.outcome === 'replayed' ? 'replayed' : 'recovered',
      lease: committed.lease,
      messageId: source.id,
    };
  }

  private async readTask(taskId: string) {
    try {
      return await this.deps.tasks.get(taskId);
    } catch {
      return null;
    }
  }

  private async resolveTaskAuthority(taskId: string, lease: ActionSuccessorLease): Promise<TaskAuthority> {
    const task = await this.readTask(taskId);
    if (!task) return { ok: false, reason: 'task_unreadable' };
    const entrusted = task.entrustedWork;
    const holderCatId = lease.holderCatIds[0];
    const predecessorCatId = lease.predecessorCatId;
    if (
      task.kind !== 'work' ||
      task.status === 'done' ||
      task.userId !== lease.tenantScope ||
      task.ownerCatId !== predecessorCatId ||
      task.threadId !== lease.predecessorThreadId ||
      !entrusted ||
      entrusted.closure.state !== 'open' ||
      !entrusted.developmentScope ||
      !holderCatId ||
      !predecessorCatId
    ) {
      return { ok: false, reason: 'task_mismatch' };
    }
    let binding: Awaited<ReturnType<typeof resolveTaskExecutionBinding>>;
    try {
      binding = await resolveTaskExecutionBinding(task, lease, this.deps.delegates);
    } catch {
      return { ok: false, reason: 'delegate_unreadable' };
    }
    if (
      binding.kind !== 'ready' ||
      binding.binding.leaseId !== lease.leaseId ||
      binding.binding.generation !== lease.generation ||
      binding.binding.threadId !== lease.holderThreadId ||
      binding.binding.catId !== holderCatId
    ) {
      return { ok: false, reason: 'delegate_mismatch' };
    }
    return { ok: true, task, entrusted, holderCatId, predecessorCatId };
  }

  private async adoptCurrentRecovery(
    lease: ActionSuccessorLease,
    recovery: NonNullable<ReturnType<typeof currentOrphanCarrierRecovery>>,
  ): Promise<TaskActionSuccessorOrphanRecoveryResult> {
    const sourceResolution = await resolveOrphanCarrierSource(this.deps.messages, lease, {
      dispatchId: recovery.fromDispatchId,
      lifecycle: 'bound',
      expectedMessageId: recovery.sourceMessageId,
    });
    if (!sourceResolution.ok) return refused(sourceResolution.reason);
    const { source } = sourceResolution;
    let entries: QueueLedgerEntry[];
    try {
      entries = await this.deps.queue.listAllDurable(lease.holderThreadId);
    } catch {
      return refused('store_unreadable');
    }
    const matches = entries.filter((entry) => isExactOrphanRecoveryEntry(entry, source, lease));
    if (matches.length !== 1) return refused('carrier_state_missing');
    const entry = matches[0];
    if (!entry) return refused('carrier_state_missing');
    try {
      prepareQueueLedgerSourceLifecycle(source, [entry]);
      if (entry.status === 'queued') await this.deps.queue.adoptCommittedAdmission([entry], source);
    } catch {
      return refused('carrier_adoption_failed');
    }
    return { outcome: 'replayed', lease, messageId: source.id };
  }

  private async carrierOrExecutionBlocker(lease: ActionSuccessorLease, source: StoredMessage): Promise<string | null> {
    const holder = lease.holderCatIds[0];
    if (!holder) return 'authority_mismatch';
    try {
      const [entries, records, turns] = await Promise.all([
        this.readExecutionEvidence('queue_ledger', lease, source.id, () =>
          this.deps.queue.listAllDurable(lease.holderThreadId),
        ),
        this.readExecutionEvidence('invocation_records', lease, source.id, () => {
          if (!this.deps.invocationRecords.scanAll) throw new Error('Invocation record scanAll reader unavailable');
          return this.deps.invocationRecords.scanAll();
        }),
        this.readExecutionEvidence('turn_executions', lease, source.id, () =>
          this.deps.turnExecutions.listBySource({
            userId: lease.tenantScope,
            threadId: lease.holderThreadId,
            catId: holder,
            messageId: source.id,
          }),
        ),
      ]);
      const fence = buildActionSuccessorFence(lease, lease.dispatchId);
      if (
        entries.some(
          (entry) =>
            entry.payload.sourceRecordId === source.id ||
            actionSuccessorFencesMatch(entry.execution.actionSuccessorFence, fence),
        )
      ) {
        return 'carrier_state_present';
      }
      if (turns.length > 0) return 'execution_present';
      return records.some(
        (record) =>
          record.userMessageId === source.id ||
          (record.actionLeaseCarrier.kind === 'action_successor' &&
            record.actionLeaseCarrier.leaseId === lease.leaseId &&
            record.actionLeaseCarrier.generation === lease.generation),
      )
        ? 'execution_present'
        : null;
    } catch {
      return 'execution_unreadable';
    }
  }

  private async readExecutionEvidence<T>(
    stage: ExecutionReadStage,
    lease: ActionSuccessorLease,
    sourceMessageId: string,
    read: () => T | Promise<T>,
  ): Promise<T> {
    try {
      return await read();
    } catch (err) {
      (this.deps.logger ?? log).warn(
        {
          stage,
          err,
          leaseId: lease.leaseId,
          generation: lease.generation,
          threadId: lease.holderThreadId,
          sourceMessageId,
        },
        'Orphan recovery execution read failed',
      );
      throw err;
    }
  }
}

function taskIdFromLease(lease: ActionSuccessorLease): string | null {
  const prefix = 'subject:task:';
  return lease.actionFamily === 'implement' &&
    lease.successorSlot === 'implementer' &&
    lease.subjectRef.startsWith(prefix)
    ? lease.subjectRef.slice(prefix.length) || null
    : null;
}

function refused(reason: string): TaskActionSuccessorOrphanRecoveryResult {
  return { outcome: 'refused', reason };
}
