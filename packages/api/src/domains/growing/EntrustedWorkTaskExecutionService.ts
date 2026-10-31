import type { EntrustedWorkTaskExecutionStopV1, EntrustedWorkTaskExecutionV1, TaskItem } from '@cat-cafe/shared';
import { entrustedWorkTaskExecutionStopV1Schema, entrustedWorkTaskExecutionV1Schema } from '@cat-cafe/shared';
import type { ActionSuccessorLeaseStore } from '../ball-custody/ActionSuccessorLeaseStore.js';
import type { TaskApprovedDelegateProvider } from '../ball-custody/action-subject-delegate-contract.js';
import type { ActionSuccessorLease } from '../ball-custody/action-successor-state-machine.js';
import type { IInvocationRecordStore, InvocationRecord } from '../cats/services/stores/ports/InvocationRecordStore.js';
import type { ITurnExecutionStore } from '../cats/services/stores/ports/TurnExecutionStore.js';
import { resolveTaskExecutionBinding, type TaskExecutionBinding } from './EntrustedWorkTaskExecutionBinding.js';
import { collectTaskExecutionCandidates, type TaskExecutionCandidate } from './EntrustedWorkTaskExecutionCandidates.js';
import {
  controlForTaskBindingRecord,
  type ExactInvocationTracker,
  type ExactTaskExecutionControl,
  taskExecutionIdentity,
  taskExecutionRefs,
  taskExecutionTaskRef,
} from './EntrustedWorkTaskExecutionEvidence.js';

export interface EntrustedWorkTaskExecutionInspection {
  readonly projection: EntrustedWorkTaskExecutionV1;
  /** Server-private abort coordinates. They are emitted only after exact lease-carrier proof. */
  readonly control?: ExactTaskExecutionControl;
}

export interface EntrustedWorkTaskExecutionServiceDeps {
  readonly leaseStore?: Pick<ActionSuccessorLeaseStore, 'getByIdentity'>;
  readonly invocationRecords?: Pick<IInvocationRecordStore, 'listRunningByThread' | 'get'>;
  readonly turnExecutions?: Pick<ITurnExecutionStore, 'listRunningByUser'>;
  readonly tracker?: ExactInvocationTracker;
  readonly taskApprovedDelegateProvider?: TaskApprovedDelegateProvider;
  readonly now?: () => number;
}

type ProjectionReason = EntrustedWorkTaskExecutionV1['reasonCode'];
type BindingLoadResult =
  | {
      readonly kind: 'ready';
      readonly lease: ActionSuccessorLease;
      readonly binding: TaskExecutionBinding;
      readonly userId: string;
    }
  | { readonly kind: 'projected'; readonly inspection: EntrustedWorkTaskExecutionInspection };

/**
 * Joins Task custody to execution owner truth through one exact ActionSuccessor lease.
 * Thread activity and prose are deliberately absent from the dependency surface.
 */
export class EntrustedWorkTaskExecutionService {
  private readonly now: () => number;

  constructor(private readonly deps: EntrustedWorkTaskExecutionServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  async read(task: TaskItem): Promise<EntrustedWorkTaskExecutionV1> {
    return (await this.inspect(task)).projection;
  }

  async inspect(task: TaskItem): Promise<EntrustedWorkTaskExecutionInspection> {
    const loaded = await this.loadBinding(task);
    if (loaded.kind === 'projected') return loaded.inspection;
    const { binding, lease, userId } = loaded;
    const invocationRecords = this.deps.invocationRecords;
    const turnExecutions = this.deps.turnExecutions;
    if (!invocationRecords || !turnExecutions) {
      return { projection: this.unknown(task, 'execution_truth_unavailable', binding) };
    }
    const collected = await collectTaskExecutionCandidates({
      userId,
      lease,
      invocationRecords,
      turnExecutions,
    });
    if (collected.kind === 'failed') {
      return { projection: this.unknown(task, collected.reason, binding) };
    }
    const { candidates } = collected;
    if (candidates.size > 1) {
      return { projection: this.unknown(task, 'ambiguous_task_execution', binding) };
    }
    const [candidate] = candidates.values();
    return candidate
      ? this.runningInspection(task, binding, candidate)
      : this.projectWithoutRunningCarrier(task, lease, binding);
  }

  private async loadBinding(task: TaskItem): Promise<BindingLoadResult> {
    if (!task.userId || !this.deps.leaseStore) {
      return { kind: 'projected', inspection: { projection: this.unknown(task, 'binding_source_unavailable') } };
    }
    let lease: ActionSuccessorLease | null;
    try {
      lease = await this.deps.leaseStore.getByIdentity(taskExecutionIdentity(task));
    } catch {
      return { kind: 'projected', inspection: { projection: this.unknown(task, 'binding_source_unavailable') } };
    }
    if (!lease) {
      const projection = task.ownerCatId
        ? this.unknown(task, 'binding_missing_for_assignee')
        : this.projection(task, {
            state: 'idle',
            reasonCode: 'unassigned_without_binding',
            canConfirmSatisfied: true,
          });
      return { kind: 'projected', inspection: { projection } };
    }
    const binding = await resolveTaskExecutionBinding(task, lease, this.deps.taskApprovedDelegateProvider);
    if (binding.kind === 'ready') return { kind: 'ready', lease, binding: binding.binding, userId: task.userId };
    return {
      kind: 'projected',
      inspection: {
        projection: this.unknown(
          task,
          binding.kind === 'source_unavailable' ? 'binding_source_unavailable' : 'binding_task_mismatch',
        ),
      },
    };
  }

  private runningInspection(
    task: TaskItem,
    binding: TaskExecutionBinding,
    candidate: TaskExecutionCandidate,
  ): EntrustedWorkTaskExecutionInspection {
    const executionBinding = { ...binding, generation: candidate.generation, catId: candidate.catId };
    return {
      projection: this.projection(task, {
        state: 'running',
        reasonCode: candidate.reason,
        canConfirmSatisfied: false,
        binding: executionBinding,
        execution: {
          parentInvocationId: candidate.parentInvocationId,
          ...(candidate.childInvocationId ? { childInvocationId: candidate.childInvocationId } : {}),
        },
      }),
      control: candidate,
    };
  }

  private projectWithoutRunningCarrier(
    task: TaskItem,
    lease: ActionSuccessorLease,
    binding: TaskExecutionBinding,
  ): EntrustedWorkTaskExecutionInspection {
    if (lease.status === 'active' && lease.dispatchDeliveryState === 'pending') {
      return {
        projection: this.projection(task, {
          state: 'queued',
          reasonCode: 'dispatch_pending',
          canConfirmSatisfied: false,
          binding,
        }),
      };
    }
    if (lease.status === 'active') {
      return { projection: this.unknown(task, 'carrier_state_unresolved', binding) };
    }
    return {
      projection: this.projection(task, {
        state: 'idle',
        reasonCode: 'terminal_binding_without_execution',
        canConfirmSatisfied: true,
        binding,
      }),
    };
  }

  async stopAfterTerminal(
    task: TaskItem,
    inspection: EntrustedWorkTaskExecutionInspection,
  ): Promise<EntrustedWorkTaskExecutionStopV1> {
    const { projection, control } = inspection;
    if (projection.state === 'idle') {
      return this.stopResult('not_running', 'task_binding_idle');
    }
    if (projection.state === 'unknown') {
      return this.stopResult('unknown', 'task_execution_unknown');
    }
    if (projection.state === 'queued') return this.confirmQueuedRetirement(task, projection.binding);
    if (!control || !this.deps.tracker) {
      return this.stopResult('unknown', 'execution_control_unavailable', taskExecutionRefs(control));
    }

    return this.stopExactControl(control);
  }

  private stopExactControl(control: ExactTaskExecutionControl): EntrustedWorkTaskExecutionStopV1 {
    const tracker = this.deps.tracker;
    if (!tracker) return this.stopResult('unknown', 'execution_control_unavailable', taskExecutionRefs(control));

    try {
      const result = tracker.cancelExact(
        control.threadId,
        control.catId,
        control.parentInvocationId,
        control.userId,
        'task_cancelled',
      );
      if (result.cancelled && result.executionIds?.includes(control.parentInvocationId)) {
        return this.stopResult('stopped', 'exact_tracker_execution_aborted', taskExecutionRefs(control));
      }
      if (result.state === 'user_mismatch') {
        return this.stopResult('not_stopped', 'exact_tracker_user_mismatch', taskExecutionRefs(control));
      }
      return this.stopResult('not_stopped', 'exact_tracker_execution_missing', taskExecutionRefs(control));
    } catch {
      return this.stopResult('unknown', 'execution_control_unavailable', taskExecutionRefs(control));
    }
  }

  private async confirmQueuedRetirement(
    task: TaskItem,
    observedBinding: TaskExecutionBinding,
  ): Promise<EntrustedWorkTaskExecutionStopV1> {
    let current: EntrustedWorkTaskExecutionInspection;
    try {
      current = await this.inspect(task);
    } catch {
      return this.stopResult('unknown', 'execution_control_unavailable');
    }
    const currentBinding = current.projection.binding;
    if (!currentBinding) return this.stopResult('unknown', 'task_execution_unknown');
    if (!this.sameBinding(observedBinding, currentBinding)) {
      return this.stopResult('not_stopped', 'exact_tracker_execution_missing');
    }
    if (current.projection.state === 'running') return this.stopAfterTerminal(task, current);
    if (current.projection.state === 'idle' && current.projection.reasonCode === 'terminal_binding_without_execution') {
      return this.stopAdmittedQueuedCarrier(task, observedBinding);
    }
    if (current.projection.state === 'queued') {
      return this.stopResult('not_stopped', 'terminal_binding_still_active');
    }
    return this.stopResult('unknown', 'task_execution_unknown');
  }

  private async stopAdmittedQueuedCarrier(
    task: TaskItem,
    binding: TaskExecutionBinding,
  ): Promise<EntrustedWorkTaskExecutionStopV1> {
    const tracker = this.deps.tracker;
    const invocationRecords = this.deps.invocationRecords;
    if (!tracker?.getExecutionId || !invocationRecords || !task.userId) {
      return this.stopResult('unknown', 'execution_control_unavailable');
    }
    const executionId = tracker.getExecutionId(binding.threadId, binding.catId);
    if (!executionId) return this.stopResult('prevented_start', 'queued_binding_retired');

    let record: InvocationRecord | null;
    try {
      record = await invocationRecords.get(executionId);
    } catch {
      return this.stopResult('unknown', 'execution_control_unavailable', [executionId]);
    }
    if (!record) return this.stopResult('unknown', 'task_execution_unknown', [executionId]);
    const control = controlForTaskBindingRecord(record, binding, task.userId);
    if (!control) return this.stopResult('not_stopped', 'exact_tracker_execution_missing', [executionId]);
    if (record.status !== 'queued' && record.status !== 'failed' && record.status !== 'running') {
      return this.stopResult('unknown', 'task_execution_unknown', [executionId]);
    }
    return this.stopExactControl(control);
  }

  private sameBinding(left: TaskExecutionBinding, right: TaskExecutionBinding): boolean {
    return (
      left.leaseId === right.leaseId &&
      left.generation === right.generation &&
      left.threadId === right.threadId &&
      left.catId === right.catId
    );
  }

  private unknown(
    task: TaskItem,
    reasonCode: Extract<
      ProjectionReason,
      | `${string}unavailable`
      | `${string}missing${string}`
      | `${string}mismatch`
      | 'carrier_state_unresolved'
      | 'ambiguous_task_execution'
    >,
    binding?: { leaseId: string; generation: number; threadId: string; catId: string },
  ): EntrustedWorkTaskExecutionV1 {
    return this.projection(task, {
      state: 'unknown',
      reasonCode,
      canConfirmSatisfied: false,
      ...(binding ? { binding } : {}),
    });
  }

  private projection(
    task: TaskItem,
    state:
      | Pick<
          Extract<EntrustedWorkTaskExecutionV1, { state: 'idle' }>,
          'state' | 'reasonCode' | 'canConfirmSatisfied' | 'binding'
        >
      | Pick<
          Extract<EntrustedWorkTaskExecutionV1, { state: 'queued' }>,
          'state' | 'reasonCode' | 'canConfirmSatisfied' | 'binding'
        >
      | Pick<
          Extract<EntrustedWorkTaskExecutionV1, { state: 'running' }>,
          'state' | 'reasonCode' | 'canConfirmSatisfied' | 'binding' | 'execution'
        >
      | Pick<
          Extract<EntrustedWorkTaskExecutionV1, { state: 'unknown' }>,
          'state' | 'reasonCode' | 'canConfirmSatisfied' | 'binding'
        >,
  ): EntrustedWorkTaskExecutionV1 {
    return entrustedWorkTaskExecutionV1Schema.parse({
      v: 1,
      scope: 'task_binding',
      observedAt: this.now(),
      taskRef: taskExecutionTaskRef(task),
      ...state,
    });
  }

  private stopResult(
    state: EntrustedWorkTaskExecutionStopV1['state'],
    reasonCode: EntrustedWorkTaskExecutionStopV1['reasonCode'],
    refs: string[] = [],
  ): EntrustedWorkTaskExecutionStopV1 {
    return entrustedWorkTaskExecutionStopV1Schema.parse({ state, reasonCode, executionRefs: refs });
  }
}
