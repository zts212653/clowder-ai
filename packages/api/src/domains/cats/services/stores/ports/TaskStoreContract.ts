import type {
  AutomationState,
  CreateTaskInput,
  EntrustedWorkV1,
  ManagedWorkBinding,
  TaskItem,
  TaskKind,
  UpdateTaskInput,
} from '@cat-cafe/shared';

export const ENTRUSTED_WORK_TERMINAL_ACTION_REQUIRED = 'ENTRUSTED_WORK_TERMINAL_ACTION_REQUIRED' as const;
export const ENTRUSTED_WORK_ADMISSION_CONFLICT = 'ENTRUSTED_WORK_ADMISSION_CONFLICT' as const;
export const TASK_SUBJECT_ALREADY_EXISTS = 'TASK_SUBJECT_ALREADY_EXISTS' as const;
export const TASK_SUBJECT_NAMESPACE_RESERVED = 'TASK_SUBJECT_NAMESPACE_RESERVED' as const;

export type EntrustedWorkTerminalClosure = Exclude<EntrustedWorkV1['closure'], { state: 'open' }>;

export interface AdmitEntrustedWorkStoreInput {
  readonly subjectKey: string;
  readonly task: Pick<CreateTaskInput, 'threadId' | 'title' | 'why' | 'createdBy' | 'ownerCatId' | 'userId'>;
  readonly entrustedWork: EntrustedWorkV1;
}

export interface AdmitEntrustedWorkStoreResult {
  readonly kind: 'admitted' | 'resumed';
  readonly task: TaskItem;
}

export interface CloseEntrustedWorkStoreInput {
  readonly expectedRevision: number;
  readonly closure: EntrustedWorkTerminalClosure;
}

export type CloseEntrustedWorkStoreResult =
  | { readonly kind: 'closed'; readonly task: TaskItem }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'not_entrusted'; readonly task: TaskItem }
  | { readonly kind: 'revision_conflict' | 'already_closed'; readonly task: TaskItem };

export interface UpdateEntrustedWorkStoreInput {
  readonly expectedRevision: number;
  readonly time?: {
    readonly businessDeadline?: EntrustedWorkV1['time']['businessDeadline'] | null;
    readonly reviewBy?: EntrustedWorkV1['time']['reviewBy'] | null;
  };
  readonly artifactRefs?: readonly string[];
}

export type UpdateEntrustedWorkStoreResult =
  | { readonly kind: 'updated'; readonly task: TaskItem }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'not_entrusted'; readonly task: TaskItem }
  | { readonly kind: 'revision_conflict' | 'already_closed' | 'no_change'; readonly task: TaskItem };

export function createEntrustedWorkTerminalActionRequiredError(taskId: string): Error & { code: string } {
  return Object.assign(new Error(`Entrusted work task ${taskId} requires a typed closure action`), {
    code: ENTRUSTED_WORK_TERMINAL_ACTION_REQUIRED,
  });
}

export function createEntrustedWorkAdmissionConflictError(subjectKey: string): Error & { code: string } {
  return Object.assign(new Error(`Entrusted work admission conflicts with subject ${subjectKey}`), {
    code: ENTRUSTED_WORK_ADMISSION_CONFLICT,
  });
}

export function createTaskSubjectAlreadyExistsError(subjectKey: string): Error & { code: string } {
  return Object.assign(new Error(`Task subject ${subjectKey} already has a canonical owner`), {
    code: TASK_SUBJECT_ALREADY_EXISTS,
  });
}

export function isEntrustedWorkSubjectKey(subjectKey: string): boolean {
  return subjectKey.startsWith('entrusted:');
}

export function assertGenericTaskSubjectNamespaceAllowed(subjectKey: string): void {
  if (!isEntrustedWorkSubjectKey(subjectKey)) return;
  throw Object.assign(
    new Error(`Task subject namespace is reserved for typed entrusted-work admission: ${subjectKey}`),
    {
      code: TASK_SUBJECT_NAMESPACE_RESERVED,
    },
  );
}

export function assertEntrustedWorkReplayCompatible(
  subjectKey: string,
  existing: TaskItem,
  proposed: EntrustedWorkV1,
): void {
  const current = existing.entrustedWork;
  const replayShape = (work: EntrustedWorkV1) => ({
    basis: work.admission.basis,
    sourceRefs: work.admission.sourceRefs,
    idempotencyKey: work.admission.idempotencyKey,
    authorityRef: 'authorityRef' in work.admission ? work.admission.authorityRef : undefined,
    intendedOutcome: work.intendedOutcome,
    closure: {
      condition: work.closure.condition,
      expectedSignal: work.closure.expectedSignal,
    },
  });
  if (
    existing.kind !== 'work' ||
    existing.subjectKey !== subjectKey ||
    !current ||
    JSON.stringify(replayShape(current)) !== JSON.stringify(replayShape(proposed))
  ) {
    throw createEntrustedWorkAdmissionConflictError(subjectKey);
  }
}

export function isEntrustedWorkTerminalActionRequiredError(
  error: unknown,
): error is Error & { code: typeof ENTRUSTED_WORK_TERMINAL_ACTION_REQUIRED } {
  return (
    error instanceof Error && (error as Error & { code?: string }).code === ENTRUSTED_WORK_TERMINAL_ACTION_REQUIRED
  );
}

export function assertEntrustedWorkStatusUpdateAllowed(task: TaskItem, input: UpdateTaskInput): void {
  if (!task.entrustedWork) return;
  const changesCustodyOwner = input.ownerCatId !== undefined && input.ownerCatId !== task.ownerCatId;
  const changesCustodyThread = input.threadId !== undefined && input.threadId !== task.threadId;
  if (input.status === 'done' || changesCustodyOwner || changesCustodyThread) {
    throw createEntrustedWorkTerminalActionRequiredError(task.id);
  }
}

export function assertEntrustedWorkGenericUpdateAllowed(task: TaskItem): void {
  if (!task.entrustedWork) return;
  throw Object.assign(new Error(`Entrusted work task ${task.id} cannot be updated outside its typed lifecycle`), {
    code: ENTRUSTED_WORK_TERMINAL_ACTION_REQUIRED,
  });
}

export function assertEntrustedWorkGenericDeletionAllowed(task: TaskItem): void {
  if (!task.entrustedWork) return;
  throw Object.assign(new Error(`Entrusted work task ${task.id} cannot be deleted outside its typed lifecycle`), {
    code: ENTRUSTED_WORK_TERMINAL_ACTION_REQUIRED,
  });
}

export function assertEntrustedWorkGenericUpsertAllowed(task: TaskItem): void {
  if (!task.entrustedWork) return;
  throw Object.assign(new Error(`Entrusted work task ${task.id} cannot be upserted outside its typed lifecycle`), {
    code: ENTRUSTED_WORK_TERMINAL_ACTION_REQUIRED,
  });
}

/** Common server-side contract for in-memory and Redis task stores. */
export interface ITaskStore {
  create(input: CreateTaskInput): TaskItem | Promise<TaskItem>;
  get(taskId: string): TaskItem | null | Promise<TaskItem | null>;
  update(taskId: string, input: UpdateTaskInput): TaskItem | null | Promise<TaskItem | null>;
  updateIfThreadId(
    taskId: string,
    expectedThreadId: string,
    input: UpdateTaskInput,
  ): TaskItem | null | Promise<TaskItem | null>;
  listByThread(threadId: string): TaskItem[] | Promise<TaskItem[]>;
  delete(taskId: string): boolean | Promise<boolean>;
  deleteByThread(threadId: string): number | Promise<number>;
  getBySubject(subjectKey: string): TaskItem | null | Promise<TaskItem | null>;
  upsertBySubject(input: CreateTaskInput): TaskItem | Promise<TaskItem>;
  upsertBySubjectWithManagedWorkBinding(
    input: CreateTaskInput,
    binding: ManagedWorkBinding,
  ): TaskItem | Promise<TaskItem>;
  listByKind(kind: TaskKind): TaskItem[] | Promise<TaskItem[]>;
  patchAutomationState(taskId: string, patch: Partial<AutomationState>): TaskItem | null | Promise<TaskItem | null>;
  bindManagedWorkBinding(
    taskId: string,
    binding: ManagedWorkBinding,
  ): ManagedWorkBinding | null | Promise<ManagedWorkBinding | null>;
  getManagedWorkBinding(taskId: string): ManagedWorkBinding | null | Promise<ManagedWorkBinding | null>;
  admitEntrustedWork(
    input: AdmitEntrustedWorkStoreInput,
  ): AdmitEntrustedWorkStoreResult | Promise<AdmitEntrustedWorkStoreResult>;
  closeEntrustedWork(
    taskId: string,
    input: CloseEntrustedWorkStoreInput,
  ): CloseEntrustedWorkStoreResult | Promise<CloseEntrustedWorkStoreResult>;
  updateEntrustedWork(
    taskId: string,
    input: UpdateEntrustedWorkStoreInput,
  ): UpdateEntrustedWorkStoreResult | Promise<UpdateEntrustedWorkStoreResult>;
  /** Replace complete state only while the observed wait generation/task revision is still current. */
  replaceAutomationStateIfGeneration(
    taskId: string,
    input: ReplaceAutomationStateIfGenerationInput,
  ): TaskItem | null | Promise<TaskItem | null>;
}

export interface ReplaceAutomationStateIfGenerationInput {
  readonly expectedGeneration: number | null;
  readonly expectedUpdatedAt?: number;
  readonly automationState: AutomationState | undefined;
  readonly why?: string;
  readonly status?: TaskItem['status'];
}
