import type { TaskItem } from '@cat-cafe/shared';
import type { IMessageStore } from '../cats/services/stores/ports/MessageStore.js';
import type { ITurnExecutionStore } from '../cats/services/stores/ports/TurnExecutionStore.js';
import { resolveTaskExecutionBinding } from '../growing/EntrustedWorkTaskExecutionBinding.js';
import type { ActionSuccessorLeaseStore } from './ActionSuccessorLeaseStore.js';
import type { TaskApprovedDelegateProvider } from './action-subject-delegate-contract.js';
import { resolveOrphanCarrierSource } from './action-successor-orphan-carrier-source.js';

export type LegacyTaskExecution =
  | { kind: 'idle' }
  | { kind: 'unknown' }
  | { kind: 'execution'; execution: NonNullable<TaskItem['executionRef']> };

/** First-use compatibility only. Old leases locate execution history; their active/terminal status grants nothing. */
export class LegacyTaskExecutionResolver {
  constructor(
    private readonly deps: {
      leases?: Pick<ActionSuccessorLeaseStore, 'getByIdentity'>;
      messages: Pick<IMessageStore, 'getByIdempotencyKey' | 'getByThreadBeforeBounded'>;
      turns: Pick<ITurnExecutionStore, 'listBySource'>;
      delegates?: TaskApprovedDelegateProvider;
    },
  ) {}

  async resolve(task: TaskItem): Promise<LegacyTaskExecution> {
    if (task.ownerRevision !== undefined || task.executionRef) return { kind: 'idle' };
    if (!task.userId || !this.deps.leases) return { kind: 'unknown' };
    const lease = await this.deps.leases.getByIdentity({
      tenantScope: task.userId,
      subjectRef: `subject:task:${task.id}`,
      actionFamily: 'implement',
      successorSlot: 'implementer',
    });
    if (!lease) return { kind: 'idle' };
    const resolved = await resolveTaskExecutionBinding(task, lease, this.deps.delegates);
    if (resolved.kind !== 'ready') return { kind: 'unknown' };
    const unbound = await resolveOrphanCarrierSource(this.deps.messages, lease, {
      dispatchId: lease.dispatchId,
      lifecycle: 'unbound',
    });
    const source = unbound.ok
      ? unbound
      : await resolveOrphanCarrierSource(this.deps.messages, lease, {
          dispatchId: lease.dispatchId,
          lifecycle: 'bound',
        });
    if (!source.ok) return { kind: 'unknown' };
    const records = await this.deps.turns.listBySource({
      userId: task.userId,
      catId: resolved.binding.catId,
      threadId: resolved.binding.threadId,
      messageId: source.source.id,
    });
    if (records.length === 0) return { kind: 'idle' };
    const notClosed = records.filter((turn) => turn.providerTeardownAt === undefined);
    if (notClosed.length === 0) return { kind: 'idle' };
    if (notClosed.length !== 1) return { kind: 'unknown' };
    const turn = notClosed[0]!;
    return {
      kind: 'execution',
      execution: {
        invocationId: turn.invocationId,
        parentInvocationId: turn.parentInvocationId,
        catId: turn.catId,
        threadId: turn.threadId,
        sourceMessageId: source.source.id,
      },
    };
  }
}
