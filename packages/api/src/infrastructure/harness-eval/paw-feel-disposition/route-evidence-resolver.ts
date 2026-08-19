import type { ActionSuccessorLeaseStore } from '../../../domains/ball-custody/ActionSuccessorLeaseStore.js';
import type { ITaskStore } from '../../../domains/cats/services/stores/ports/TaskStore.js';
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
}
