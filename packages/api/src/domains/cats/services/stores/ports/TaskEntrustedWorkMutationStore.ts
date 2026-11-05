import type { TaskItem } from '@cat-cafe/shared';
import { entrustedWorkV1Schema } from '@cat-cafe/shared';
import {
  type AttachEntrustedWorkArtifactInput,
  captureEntrustedWorkArtifactInput,
  prepareEntrustedWorkArtifactEvidence,
} from './EntrustedWorkArtifactEvidence.js';
import { prepareEntrustedWorkUpdate } from './EntrustedWorkContractUpdate.js';
import { advanceEntrustedWorkRevision } from './EntrustedWorkRevision.js';
import { reconcileDeploymentWaitTaskMutation } from './TaskDeploymentWaitState.js';
import type {
  CloseEntrustedWorkStoreInput,
  CloseEntrustedWorkStoreResult,
  UpdateEntrustedWorkStoreInput,
  UpdateEntrustedWorkStoreResult,
} from './TaskStoreContract.js';

/** Owns the in-memory compare-and-transition boundary for entrusted Task mutations. */
export class TaskEntrustedWorkMutationStore {
  constructor(private readonly tasks: Map<string, TaskItem>) {}

  attachArtifact(taskId: string, raw: AttachEntrustedWorkArtifactInput) {
    const input = captureEntrustedWorkArtifactInput(raw);
    const result = prepareEntrustedWorkArtifactEvidence(this.tasks.get(taskId) ?? null, input);
    if (result.kind === 'attached') this.tasks.set(taskId, result.task);
    return result;
  }

  close(taskId: string, input: CloseEntrustedWorkStoreInput): CloseEntrustedWorkStoreResult {
    const existing = this.tasks.get(taskId);
    if (!existing) return { kind: 'not_found' };
    if (input.expectedThreadId !== undefined && existing.threadId !== input.expectedThreadId)
      return { kind: 'thread_conflict', task: existing };
    if (!existing.entrustedWork) return { kind: 'not_entrusted', task: existing };
    if (existing.entrustedWork.closure.state !== 'open') return { kind: 'already_closed', task: existing };
    if (existing.entrustedWork.revision !== input.expectedRevision) {
      return { kind: 'revision_conflict', task: existing };
    }

    const { completion: _previousCompletion, ...openWork } = existing.entrustedWork;
    const entrustedWork = entrustedWorkV1Schema.parse({
      ...openWork,
      ...advanceEntrustedWorkRevision(existing.entrustedWork),
      closure: input.closure,
      ...(input.closure.state === 'satisfied'
        ? {
            completion: {
              recordedAt: Date.now(),
              ...(input.artifactSnapshot ? { artifactSnapshot: input.artifactSnapshot } : {}),
            },
          }
        : {}),
    });
    const updated: TaskItem = reconcileDeploymentWaitTaskMutation(existing, {
      ...existing,
      status: 'done',
      entrustedWork,
      updatedAt: Date.now(),
    });
    this.tasks.set(taskId, updated);
    return { kind: 'closed', task: updated };
  }

  update(taskId: string, input: UpdateEntrustedWorkStoreInput): UpdateEntrustedWorkStoreResult {
    const existing = this.tasks.get(taskId);
    const prepared = prepareEntrustedWorkUpdate(existing ?? null, input);
    if (prepared.kind !== 'ready') return prepared;
    if (!existing) return { kind: 'not_found' };
    const updated: TaskItem = {
      ...existing,
      status: prepared.status,
      entrustedWork: prepared.entrustedWork,
      updatedAt: Date.now(),
    };
    this.tasks.set(taskId, updated);
    return { kind: 'updated', task: updated };
  }
}
