import {
  ownerTruthRefV1Schema,
  type PawFeelDirectRepairBindingV1,
  type PawFeelDispositionProjection,
} from '@cat-cafe/shared';
import type { ActionSuccessorLeaseStore } from '../../../domains/ball-custody/ActionSuccessorLeaseStore.js';
import type { ITaskStore } from '../../../domains/cats/services/stores/ports/TaskStore.js';
import type { PawFeelRepairProgress } from './continuation/follow-up-resolver.js';
import type { PawFeelRepairTerminalTruth } from './direct-repair/direct-repair-outcome-resolver.js';
import type { PawFeelFixResolver } from './service.js';

type LeaseReader = Pick<ActionSuccessorLeaseStore, 'get' | 'preflight'>;
type TaskReader = Pick<ITaskStore, 'get'>;

export interface PawFeelFixEvidenceResolverOptions {
  leaseStore: LeaseReader;
  taskStore: TaskReader;
}

function taskIdFromSubjectRef(subjectRef: string): string {
  const match = /^subject:task:(\S{1,200})$/.exec(subjectRef);
  if (!match?.[1]) throw new Error('active lease does not resolve to a task subject');
  return match[1];
}

export class PawFeelFixEvidenceResolver implements PawFeelFixResolver {
  constructor(private readonly options: PawFeelFixEvidenceResolverOptions) {}

  async resolve(leaseId: string) {
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
      custodyEvidenceRef: `action-lease:${leaseId}:generation:${lease.generation}`,
    };
  }

  async resolveProgress(projection: PawFeelDispositionProjection): Promise<PawFeelRepairProgress> {
    const leaseId = projection.actionLeaseRef?.leaseId;
    const generation = projection.actionLeaseRef?.generation;
    if (!leaseId || generation === undefined || !projection.taskId || !projection.ownerCatId) {
      return { status: 'interrupted', evidenceRefs: [projection.signalId] };
    }
    const evidenceRefs = [`task:${projection.taskId}`, `action-lease:${leaseId}:generation:${generation}`];
    const [lease, task] = await Promise.all([
      this.options.leaseStore.get(leaseId),
      this.options.taskStore.get(projection.taskId),
    ]);
    if (
      !lease ||
      !task ||
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
    const leaseId = projection.actionLeaseRef?.leaseId;
    const generation = projection.actionLeaseRef?.generation;
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
    if (!task || task.id !== projection.taskId || task.status !== 'done') throw new Error('task is not done');
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
