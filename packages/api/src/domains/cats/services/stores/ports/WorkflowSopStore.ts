import type { CatId, UpdateWorkflowSopInput, WorkflowSop, WorkflowSopAdmissionBundle } from '@cat-cafe/shared';

export class VersionConflictError extends Error {
  readonly currentState: WorkflowSop;
  constructor(current: WorkflowSop) {
    super(`Version conflict: expected ${current.version - 1}, actual ${current.version}`);
    this.name = 'VersionConflictError';
    this.currentState = current;
  }
}

export class ManagedWorkExecutorConflictError extends Error {
  readonly code = 'MANAGED_WORK_EXECUTOR_CONFLICT';
  constructor(readonly executorCatId: CatId) {
    super(`Managed-work attempt is already bound to ${executorCatId}`);
    this.name = 'ManagedWorkExecutorConflictError';
  }
}

export interface IWorkflowSopStore {
  get(backlogItemId: string): Promise<WorkflowSop | null>;
  upsert(
    backlogItemId: string,
    featureId: string,
    input: UpdateWorkflowSopInput,
    updatedBy: string,
    ownerUserId: string,
  ): Promise<WorkflowSop>;
  getManagedWorkAdmission(ownerUserId: string, backlogItemId: string): Promise<WorkflowSopAdmissionBundle | null>;
  bindManagedWorkAttempt(
    ownerUserId: string,
    backlogItemId: string,
    executorCatId: CatId,
  ): Promise<WorkflowSopAdmissionBundle | null>;
  delete(backlogItemId: string): Promise<boolean>;
}
