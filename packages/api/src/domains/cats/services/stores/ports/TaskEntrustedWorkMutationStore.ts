import type { TaskItem } from '@cat-cafe/shared';
import { entrustedWorkV1Schema } from '@cat-cafe/shared';
import { prepareEntrustedWorkUpdate } from './EntrustedWorkContractUpdate.js';
import type {
  CloseEntrustedWorkStoreInput,
  CloseEntrustedWorkStoreResult,
  UpdateEntrustedWorkStoreInput,
  UpdateEntrustedWorkStoreResult,
} from './TaskStoreContract.js';

/** Owns the in-memory compare-and-transition boundary for entrusted Task mutations. */
export class TaskEntrustedWorkMutationStore {
  constructor(private readonly tasks: Map<string, TaskItem>) {}

  close(taskId: string, input: CloseEntrustedWorkStoreInput): CloseEntrustedWorkStoreResult {
    const existing = this.tasks.get(taskId);
    if (!existing) return { kind: 'not_found' };
    if (!existing.entrustedWork) return { kind: 'not_entrusted', task: existing };
    if (existing.entrustedWork.closure.state !== 'open') return { kind: 'already_closed', task: existing };
    if (existing.entrustedWork.revision !== input.expectedRevision) {
      return { kind: 'revision_conflict', task: existing };
    }

    const entrustedWork = entrustedWorkV1Schema.parse({
      ...existing.entrustedWork,
      revision: existing.entrustedWork.revision + 1,
      closure: input.closure,
    });
    const updated: TaskItem = {
      ...existing,
      status: 'done',
      entrustedWork,
      updatedAt: Date.now(),
    };
    this.tasks.set(taskId, updated);
    return { kind: 'closed', task: updated };
  }

  update(taskId: string, input: UpdateEntrustedWorkStoreInput): UpdateEntrustedWorkStoreResult {
    const existing = this.tasks.get(taskId);
    const prepared = prepareEntrustedWorkUpdate(existing ?? null, input);
    if (prepared.kind !== 'ready') return prepared;
    if (!existing) return { kind: 'not_found' };
    const updated: TaskItem = { ...existing, entrustedWork: prepared.entrustedWork, updatedAt: Date.now() };
    this.tasks.set(taskId, updated);
    return { kind: 'updated', task: updated };
  }
}
