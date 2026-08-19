import type {
  AutomationState,
  CreateTaskInput,
  ManagedWorkBinding,
  TaskItem,
  TaskKind,
  UpdateTaskInput,
} from '@cat-cafe/shared';

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
