import { createCatId, type TaskItem } from '@cat-cafe/shared';
import type { InvocationTracker } from '../cats/services/agents/invocation/InvocationTracker.js';
import type { IMessageStore, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import { ordinaryTaskExpectation, type TaskMutationActor } from '../cats/services/stores/ports/OrdinaryTaskMutation.js';
import type { ITaskStore } from '../cats/services/stores/ports/TaskStore.js';
import { isOrdinaryImplementTask } from '../cats/services/stores/ports/TaskStoreContract.js';
import type { IThreadStore } from '../cats/services/stores/ports/ThreadStore.js';
import type { ITurnExecutionStore } from '../cats/services/stores/ports/TurnExecutionStore.js';
import { MessageKeys } from '../cats/services/stores/redis-keys/message-keys.js';
import { ProposalKeys } from '../cats/services/stores/redis-keys/proposals/proposal-keys.js';
import { ThreadKeys } from '../cats/services/stores/redis-keys/thread-keys.js';
import type { TaskApprovedDelegateProvider } from './action-subject-delegate-contract.js';
import { adoptOrdinaryTaskTenant } from './adopt-ordinary-task-tenant.js';
import type { LegacyTaskExecutionResolver } from './LegacyTaskExecution.js';
import { assertTaskHandoffSource, authorizeTaskHandoff, currentTaskDelegates } from './OrdinaryTaskHandoffAuthority.js';
import {
  OrdinaryTaskHandoffError,
  type OrdinaryTaskHandoffInput,
  type OrdinaryTaskHandoffRequest,
  type OrdinaryTaskHandoffResult,
} from './OrdinaryTaskHandoffContract.js';

export interface OrdinaryTaskHandoffDeps {
  tasks: ITaskStore;
  messages: Pick<IMessageStore, 'getById'>;
  threads: Pick<IThreadStore, 'get'>;
  delegates?: TaskApprovedDelegateProvider;
  turns: Pick<ITurnExecutionStore, 'get'> &
    Partial<Pick<ITurnExecutionStore, 'recordProviderTeardown' | 'transitionTerminal'>>;
  dispatchAuthority?: {
    keys(request: OrdinaryTaskHandoffRequest): string[];
    assertCurrent(source: StoredMessage, request: OrdinaryTaskHandoffRequest): Promise<void>;
  };
  legacy?: Pick<LegacyTaskExecutionResolver, 'resolve'>;
  providerIsStopped?: (ref: NonNullable<TaskItem['executionRef']>, userId: string) => Promise<boolean>;
  stopExecution?: (ref: NonNullable<TaskItem['executionRef']>, userId: string) => Promise<void>;
  tracker?: Pick<InvocationTracker, 'cancelExact'>;
  onExecutionReleased?: (threadId: string) => void | Promise<void>;
}

/** Orchestrates existing Task/Message/execution owners. It owns no state or recovery loop. */
export class OrdinaryTaskHandoffService {
  constructor(readonly deps: OrdinaryTaskHandoffDeps) {}

  async prepare(input: OrdinaryTaskHandoffInput): Promise<OrdinaryTaskHandoffRequest> {
    let task = await this.deps.tasks.get(input.taskId);
    if (!task || !isOrdinaryImplementTask(task) || !task.ownerCatId || task.status === 'done')
      throw new OrdinaryTaskHandoffError('ordinary_task_unavailable');
    if (!task.userId) {
      if (input.actor.threadId !== task.threadId || input.actor.catId !== task.ownerCatId)
        throw new OrdinaryTaskHandoffError('task_issuer_has_no_standing');
      task = await adoptOrdinaryTaskTenant({
        task,
        userId: input.actor.userId,
        tasks: this.deps.tasks,
        threads: this.deps.threads,
      });
      if (!task?.ownerCatId) throw new OrdinaryTaskHandoffError('task_thread_authority_mismatch');
    }
    if (!Number.isSafeInteger(input.expectedOwnerRevision) || (task.ownerRevision ?? 0) !== input.expectedOwnerRevision)
      throw new OrdinaryTaskHandoffError('task_assignment_changed');
    const request: OrdinaryTaskHandoffRequest = {
      v: 1,
      issuerCreatedAt: input.issuerCreatedAt,
      taskId: task.id,
      expected: ordinaryTaskExpectation(task),
      issuer: {
        userId: input.actor.userId,
        catId: input.actor.catId,
        threadId: input.actor.threadId,
        invocationId: input.actor.invocationId,
      },
      targetCatId: input.targetCatId,
      targetThreadId: input.targetThreadId,
      ownerCatId: input.targetThreadId === task.threadId ? input.targetCatId : task.ownerCatId,
      stopPrevious: input.stopPrevious === true,
      ...(await this.anchor(task, input.targetCatId, input.targetThreadId)),
    };
    await authorizeTaskHandoff(this.deps, task, request);
    return request;
  }

  private async anchor(task: TaskItem, catId: string, threadId: string) {
    if (threadId === task.threadId) return {};
    const exact = (await currentTaskDelegates(task, this.deps.delegates)).find(
      (d) => d.catId === catId && d.threadId === threadId,
    );
    if (exact) return { approvedAnchor: exact };
    const previousId = task.lastAppliedHandoffMessageRef?.slice('message:'.length);
    const previous = previousId ? await this.deps.messages.getById(previousId) : null;
    return previous?.extra?.taskHandoff?.approvedAnchor
      ? { approvedAnchor: previous.extra.taskHandoff.approvedAnchor }
      : {};
  }

  async apply(sourceMessageId: string): Promise<OrdinaryTaskHandoffResult> {
    try {
      return await this.applyCurrent(sourceMessageId);
    } catch (error) {
      if (error instanceof OrdinaryTaskHandoffError) return { kind: 'refused', reason: error.code };
      throw error;
    }
  }

  private async applyCurrent(sourceMessageId: string): Promise<OrdinaryTaskHandoffResult> {
    const source = await this.deps.messages.getById(sourceMessageId);
    if (source?.extra?.taskHandoffInvalid) throw new OrdinaryTaskHandoffError('task_handoff_source_invalid');
    const request = source?.extra?.taskHandoff;
    if (!source || !request) return { kind: 'refused', reason: 'task_handoff_source_missing' };
    assertTaskHandoffSource(source, request);
    let task = await this.deps.tasks.get(request.taskId);
    if (!task || !isOrdinaryImplementTask(task)) return { kind: 'refused', reason: 'ordinary_task_unavailable' };
    const applied = task.lastAppliedHandoffMessageRef === `message:${sourceMessageId}`;
    const revision = request.expected.ownerRevision + Number(request.expected.ownerCatId !== request.ownerCatId);
    if (applied) {
      if (
        task.userId !== request.issuer.userId ||
        task.ownerCatId !== request.ownerCatId ||
        (task.ownerRevision ?? 0) !== revision
      )
        return { kind: 'refused', reason: 'task_assignment_changed' };
      await this.assertCurrentSource(sourceMessageId, task, request);
      return { kind: 'replayed', task };
    }
    if (
      task.ownerCatId !== request.expected.ownerCatId ||
      task.threadId !== request.expected.threadId ||
      (task.ownerRevision ?? 0) !== request.expected.ownerRevision ||
      (task.lastAppliedHandoffMessageRef ?? null) !== request.expected.lastAppliedHandoffMessageRef
    )
      return { kind: 'refused', reason: 'task_assignment_changed' };
    await this.assertCurrentSource(sourceMessageId, task, request);
    task = await this.adoptLegacyExecution(task);
    if (task.executionRef) {
      if (!(await this.releaseStoppedExecution(task))) {
        if (request.stopPrevious)
          this.deps.tracker?.cancelExact(
            task.executionRef.threadId,
            task.executionRef.catId,
            task.executionRef.parentInvocationId,
            request.issuer.userId,
            'task_handoff',
          );
        if (request.stopPrevious) await this.deps.stopExecution?.(task.executionRef, request.issuer.userId);
        if (request.stopPrevious && (await this.releaseStoppedExecution(task)))
          return this.applyCurrent(sourceMessageId);
        return { kind: 'waiting', task, executionRef: task.executionRef };
      }
      const released = await this.deps.tasks.get(task.id);
      if (!released) return { kind: 'refused', reason: 'ordinary_task_unavailable' };
      task = released;
    }
    const current = task;
    const result = await this.deps.tasks.mutateOrdinaryTask(
      {
        kind: 'handoff',
        taskId: task.id,
        expected: { ...request.expected, executionRef: null },
        ownerCatId: createCatId(request.ownerCatId),
        messageRef: `message:${sourceMessageId}`,
      },
      {
        watchKeys: this.authorityKeys(sourceMessageId, current, request),
        assertCurrent: () => this.assertCurrentSource(sourceMessageId, current, request),
      },
    );
    return result.kind === 'updated' || result.kind === 'replayed'
      ? { kind: result.kind === 'updated' ? 'applied' : 'replayed', task: result.task }
      : { kind: 'refused', reason: result.kind === 'refused' ? result.reason : 'ordinary_task_unavailable' };
  }

  private authorityKeys(source: string, task: TaskItem, request: OrdinaryTaskHandoffRequest): string[] {
    const proposal = /^proposal:([^:]+):/.exec(request.approvedAnchor?.evidenceRef ?? '')?.[1];
    return [
      ...(this.deps.dispatchAuthority?.keys(request) ?? []),
      MessageKeys.detail(source),
      ThreadKeys.detail(task.threadId),
      ThreadKeys.detail(request.issuer.threadId),
      ThreadKeys.detail(request.targetThreadId),
      ...(task.sourceMessageId ? [MessageKeys.detail(task.sourceMessageId)] : []),
      ...(task.lastAppliedHandoffMessageRef ? [MessageKeys.detail(task.lastAppliedHandoffMessageRef.slice(8))] : []),
      ...(proposal ? [ProposalKeys.detail(proposal)] : []),
    ];
  }

  private async assertCurrentSource(id: string, task: TaskItem, request: OrdinaryTaskHandoffRequest) {
    const source = await this.deps.messages.getById(id);
    if (!source?.extra?.taskHandoff || JSON.stringify(source.extra.taskHandoff) !== JSON.stringify(request))
      throw new OrdinaryTaskHandoffError('task_handoff_source_changed');
    assertTaskHandoffSource(source, request);
    const currentTask = await this.deps.tasks.get(request.taskId);
    if (!currentTask || !isOrdinaryImplementTask(currentTask) || currentTask.status === 'done')
      throw new OrdinaryTaskHandoffError('ordinary_task_unavailable');
    await authorizeTaskHandoff(this.deps, currentTask, request);
    await this.deps.dispatchAuthority?.assertCurrent(source, request);
  }

  async adoptLegacyExecution(task: TaskItem): Promise<TaskItem> {
    if (task.ownerRevision !== undefined || task.executionRef) return task;
    const legacy = await this.deps.legacy?.resolve(task);
    if (!legacy || legacy.kind === 'unknown') throw new OrdinaryTaskHandoffError('task_legacy_execution_unknown');
    if (legacy.kind === 'idle') return task;
    const result = await this.deps.tasks.mutateOrdinaryTask({
      kind: 'adopt_legacy_execution',
      taskId: task.id,
      expected: ordinaryTaskExpectation(task),
      execution: legacy.execution,
    });
    if (result.kind !== 'updated' && result.kind !== 'replayed')
      throw new OrdinaryTaskHandoffError('task_assignment_changed');
    return result.task;
  }

  async releaseStoppedExecution(task: TaskItem): Promise<boolean> {
    const ref = task.executionRef;
    if (!ref) return true;
    let turn = await this.deps.turns.get(ref.invocationId);
    if (
      !turn ||
      turn.userId !== task.userId ||
      turn.threadId !== ref.threadId ||
      turn.catId !== ref.catId ||
      turn.parentInvocationId !== ref.parentInvocationId
    )
      return false;
    if (task.userId && (await this.deps.providerIsStopped?.(ref, task.userId))) {
      await this.deps.turns.recordProviderTeardown?.(ref.invocationId, Date.now());
      if (turn.status === 'running')
        await this.deps.turns.transitionTerminal?.(ref.invocationId, {
          status: 'interrupted',
          endedAt: Date.now(),
          terminalReason: 'provider_stopped',
          providerTeardownAt: Date.now(),
        });
      turn = await this.deps.turns.get(ref.invocationId);
    }
    if (
      !turn ||
      turn.userId !== task.userId ||
      turn.threadId !== ref.threadId ||
      turn.catId !== ref.catId ||
      turn.parentInvocationId !== ref.parentInvocationId ||
      turn.status === 'running' ||
      !(
        turn.providerTeardownAt !== undefined ||
        (turn.providerLifecycleTracked &&
          turn.providerStartedAt === undefined &&
          turn.terminalReason === 'process_restart')
      )
    )
      return false;
    const result = await this.deps.tasks.mutateOrdinaryTask({
      kind: 'release_execution',
      taskId: task.id,
      expected: ordinaryTaskExpectation(task),
      execution: ref,
    });
    return result.kind === 'updated' || result.kind === 'replayed';
  }

  async start(
    sourceMessageId: string,
    actor: TaskMutationActor,
    parentInvocationId: string,
  ): Promise<string | undefined> {
    const source = await this.deps.messages.getById(sourceMessageId);
    if (source?.extra?.taskHandoffInvalid) throw new OrdinaryTaskHandoffError('task_handoff_source_invalid');
    const request = source?.extra?.taskHandoff;
    if (!request) return undefined;
    if (
      actor.userId !== request.issuer.userId ||
      actor.catId !== request.targetCatId ||
      actor.threadId !== request.targetThreadId
    )
      throw new OrdinaryTaskHandoffError('task_execution_target_mismatch');
    const applied = await this.apply(sourceMessageId);
    if (applied.kind === 'waiting' || applied.kind === 'refused')
      throw new OrdinaryTaskHandoffError(applied.kind === 'waiting' ? 'task_execution_still_running' : applied.reason);
    const task = applied.task;
    const result = await this.deps.tasks.mutateOrdinaryTask(
      {
        kind: 'bind_execution',
        taskId: task.id,
        expected: ordinaryTaskExpectation(task),
        execution: {
          invocationId: actor.invocationId,
          parentInvocationId,
          catId: actor.catId,
          threadId: actor.threadId,
          sourceMessageId,
        },
      },
      {
        watchKeys: this.authorityKeys(sourceMessageId, task, request),
        assertCurrent: () => this.assertCurrentSource(sourceMessageId, task, request),
      },
    );
    if (result.kind !== 'updated' && result.kind !== 'replayed')
      throw new OrdinaryTaskHandoffError(result.kind === 'refused' ? result.reason : 'ordinary_task_unavailable');
    return task.id;
  }

  async finish(taskId: string, invocationId: string): Promise<void> {
    const task = await this.deps.tasks.get(taskId);
    if (task?.executionRef?.invocationId !== invocationId) return;
    if (await this.releaseStoppedExecution(task)) await this.deps.onExecutionReleased?.(task.threadId);
  }

  async finishInvocation(actor: TaskMutationActor): Promise<void> {
    const tasks = await this.deps.tasks.listByThread(actor.threadId);
    for (const task of tasks) {
      if (
        isOrdinaryImplementTask(task) &&
        task.userId === actor.userId &&
        task.executionRef?.invocationId === actor.invocationId
      )
        await this.finish(task.id, actor.invocationId);
    }
  }
}
