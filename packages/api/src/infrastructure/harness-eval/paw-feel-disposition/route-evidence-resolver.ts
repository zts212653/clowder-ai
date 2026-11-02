import {
  ownerTruthRefV1Schema,
  type PawFeelDirectRepairBindingV1,
  type PawFeelDispositionProjection,
  type PawFeelRepairRequest,
  pawFeelRepairBinding,
  pawFeelRepairRequestSchema,
  repairRequestForBinding,
} from '@cat-cafe/shared';
import type { ActionSuccessorLeaseStore } from '../../../domains/ball-custody/ActionSuccessorLeaseStore.js';
import type { ITaskStore } from '../../../domains/cats/services/stores/ports/TaskStore.js';
import { isOrdinaryImplementTask } from '../../../domains/cats/services/stores/ports/TaskStoreContract.js';
import type { PawFeelRepairProgress } from './continuation/follow-up-resolver.js';
import type { PawFeelRepairTerminalTruth } from './direct-repair/direct-repair-outcome-resolver.js';
import type { PawFeelFixResolver } from './service.js';
import {
  currentTaskRepairAssignment,
  resolveTaskRepairAssignment,
  taskRepairTerminalRef,
} from './task-assignment-evidence.js';

type LeaseReader = Pick<ActionSuccessorLeaseStore, 'get' | 'preflight'>;
type TaskReader = Pick<ITaskStore, 'get'>;

export interface PawFeelFixEvidenceResolverOptions {
  leaseStore?: LeaseReader;
  taskStore: TaskReader;
}

function taskIdFromSubjectRef(subjectRef: string): string {
  const match = /^subject:task:(\S{1,200})$/.exec(subjectRef);
  if (!match?.[1]) throw new Error('active lease does not resolve to a task subject');
  return match[1];
}

export class PawFeelFixEvidenceResolver implements PawFeelFixResolver {
  constructor(private readonly options: PawFeelFixEvidenceResolverOptions) {}

  async resolve(input: PawFeelRepairRequest | string, userId?: string) {
    const request = pawFeelRepairRequestSchema.parse(
      typeof input === 'string' ? { kind: 'action_lease', leaseId: input } : input,
    );
    if (request.kind === 'task_assignment') return resolveTaskRepairAssignment(this.options.taskStore, request, userId);
    const leaseId = request.leaseId;
    if (!this.options.leaseStore) throw new Error('lease verifier unavailable');
    const lease = await this.options.leaseStore.get(leaseId);
    if (!lease || lease.leaseId !== leaseId) throw new Error('active F167 lease not found');
    const preflight = await this.options.leaseStore.preflight(leaseId, lease.generation);
    if (!preflight.ok) throw new Error(`active F167 lease failed preflight: ${preflight.reason}`);
    if (lease.mode !== 'single' || lease.holderCatIds.length !== 1 || !lease.holderCatIds[0]) {
      throw new Error('fix requires an active F167 lease with one single named holder');
    }

    const taskId = taskIdFromSubjectRef(lease.subjectRef);
    const task = await this.options.taskStore.get(taskId);
    if (!task || task.id !== taskId) throw new Error('lease task not found');
    if (isOrdinaryImplementTask(task)) throw new Error('ordinary Task leases are retired');
    if (userId && task.userId !== userId) throw new Error('repair Task tenant mismatch');
    if (task.status === 'done') throw new Error('lease task is done');
    const ownerCatId = lease.holderCatIds[0];
    if (!task.ownerCatId || task.ownerCatId !== ownerCatId) {
      throw new Error('task owner does not match the active lease holder');
    }
    if (task.threadId !== lease.holderThreadId) {
      throw new Error('task thread does not match the active lease holder thread');
    }

    return {
      ownerCatId,
      taskId,
      leaseId,
      leaseGeneration: lease.generation,
      repairBinding: {
        kind: 'action_lease' as const,
        taskId,
        leaseId,
        generation: lease.generation,
        holderThreadId: lease.holderThreadId,
      },
      custodyEvidenceRef: `action-lease:${leaseId}:generation:${lease.generation}`,
    };
  }

  async resolveCurrent(projection: PawFeelDispositionProjection) {
    const binding = pawFeelRepairBinding(projection);
    if (!binding) throw new Error('repair identity unavailable');
    if (binding.kind === 'task_assignment') {
      const task = await currentTaskRepairAssignment(this.options.taskStore, binding, projection);
      return this.resolve(repairRequestForBinding(binding), task.userId);
    }
    return this.resolve(repairRequestForBinding(binding));
  }

  async resolveProgress(projection: PawFeelDispositionProjection): Promise<PawFeelRepairProgress> {
    const binding = pawFeelRepairBinding(projection);
    if (binding?.kind === 'task_assignment') {
      const evidenceRefs = [projection.custodyEvidenceRef ?? projection.signalId];
      try {
        const task = await currentTaskRepairAssignment(this.options.taskStore, binding, projection);
        return { status: task.status === 'done' ? 'done_unverified' : 'active', evidenceRefs };
      } catch {
        return { status: 'interrupted', evidenceRefs };
      }
    }
    const leaseId = binding?.leaseId;
    const generation = binding?.generation;
    if (!leaseId || generation === undefined || !projection.taskId || !projection.ownerCatId) {
      return { status: 'interrupted', evidenceRefs: [projection.signalId] };
    }
    const evidenceRefs = [`task:${projection.taskId}`, `action-lease:${leaseId}:generation:${generation}`];
    if (!this.options.leaseStore) return { status: 'interrupted', evidenceRefs };
    const [lease, task] = await Promise.all([
      this.options.leaseStore.get(leaseId),
      this.options.taskStore.get(projection.taskId),
    ]);
    if (
      !lease ||
      !task ||
      isOrdinaryImplementTask(task) ||
      lease.generation !== generation ||
      task.ownerCatId !== projection.ownerCatId ||
      !lease.holderCatIds.includes(projection.ownerCatId)
    ) {
      return { status: 'interrupted', evidenceRefs };
    }
    const holderOutcome = lease.holderOutcomes?.[projection.ownerCatId];
    if (holderOutcome) evidenceRefs.push(holderOutcome.evidenceRef);
    if (holderOutcome && holderOutcome.outcome !== 'succeeded') {
      return { status: 'interrupted', evidenceRefs };
    }
    if (task.status === 'done') return { status: 'done_unverified', evidenceRefs };
    const preflight = await this.options.leaseStore.preflight(leaseId, generation);
    return preflight.ok
      ? { status: 'active', evidenceRefs }
      : { status: 'interrupted', evidenceRefs: [...evidenceRefs, `lease-preflight:${preflight.reason}`] };
  }

  async resolveTerminal(
    projection: PawFeelDispositionProjection,
    binding: PawFeelDirectRepairBindingV1,
  ): Promise<PawFeelRepairTerminalTruth> {
    const repair = pawFeelRepairBinding(projection);
    if (repair?.kind === 'task_assignment') {
      const task = await currentTaskRepairAssignment(this.options.taskStore, repair, projection);
      if (task.status !== 'done' || binding.ownerCatId !== task.ownerCatId)
        throw new Error('repair Task is not done by the bound owner');
      return { ownerCatId: task.ownerCatId, taskTerminalRef: taskRepairTerminalRef(task) };
    }
    if (!this.options.leaseStore) throw new Error('lease verifier unavailable');
    const leaseId = repair?.leaseId;
    const generation = repair?.generation;
    if (!leaseId || generation === undefined || !projection.taskId || !projection.ownerCatId) {
      throw new Error('fix projection has no exact task/F167 identity');
    }
    if (binding.ownerCatId !== projection.ownerCatId) throw new Error('binding owner differs from fix owner');
    const [lease, task] = await Promise.all([
      this.options.leaseStore.get(leaseId),
      this.options.taskStore.get(projection.taskId),
    ]);
    if (!lease || lease.leaseId !== leaseId || lease.generation !== generation) {
      throw new Error('terminal F167 lease is unavailable or stale');
    }
    if (!task || isOrdinaryImplementTask(task) || task.id !== projection.taskId || task.status !== 'done')
      throw new Error('task is not done');
    if (lease.subjectRef !== `subject:task:${projection.taskId}`) {
      throw new Error('terminal F167 lease does not resolve to the exact task subject');
    }
    if (
      lease.mode !== 'single' ||
      lease.holderCatIds.length !== 1 ||
      task.ownerCatId !== projection.ownerCatId ||
      lease.holderCatIds[0] !== projection.ownerCatId
    ) {
      throw new Error('terminal Task/F167 owner differs from fix owner');
    }
    if (task.threadId !== lease.holderThreadId) throw new Error('terminal Task/F167 thread binding drifted');
    if (projection.custodyEvidenceRef !== `action-lease:${leaseId}:generation:${generation}`) {
      throw new Error('terminal Task/F167 custody evidence differs from the fix binding');
    }
    const holderOutcome = lease.holderOutcomes?.[projection.ownerCatId];
    if (!holderOutcome || holderOutcome.outcome !== 'succeeded' || lease.status !== 'completed') {
      throw new Error('F167 lease has no successful terminal holder outcome');
    }
    if (!Number.isFinite(task.updatedAt)) throw new Error('task terminal revision is unavailable');
    return {
      ownerCatId: projection.ownerCatId,
      taskTerminalRef: ownerTruthRefV1Schema.parse({
        ownerFeatureId: 'F310',
        ownerStateRef: `task-terminal:${task.id}`,
        version: String(task.updatedAt),
      }),
      leaseTerminalRef: ownerTruthRefV1Schema.parse({
        ownerFeatureId: 'F167',
        ownerStateRef: `action-successor-terminal:${lease.leaseId}`,
        version: `${lease.generation}:${holderOutcome.at}`,
      }),
    };
  }
}
