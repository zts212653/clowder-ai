import { isDeepStrictEqual } from 'node:util';
import type {
  CatId,
  CreateTaskInput,
  PluginWaitUpdate,
  TaskItem,
  TaskKind,
  TaskStatus,
  UpdateTaskInput,
} from '@cat-cafe/shared';
import type { ITaskStore } from '../../../cats/services/stores/ports/TaskStore.js';
import { isTaskSubjectSnapshotConflictError } from '../../../cats/services/stores/ports/TaskStoreContract.js';
import type { IThreadStore } from '../../../cats/services/stores/ports/ThreadStore.js';
import { currentPluginCallContext, currentPluginOwnerRequestContext } from '../../carrier/plugin-call-context.js';
import { ExternalPluginRuntimeError } from '../../external-runtime/types.js';
import {
  createPluginTaskWorkData,
  type PluginTaskWorkData,
  type PluginTaskWorkMutation,
  updatePluginTaskWorkData,
} from './plugin-task-data.js';
import {
  bindPluginTaskDataController,
  currentTaskDataControllerProjection,
  type PluginTaskDataControllerBindInput,
  type PluginTaskDataControllerMutationResult,
  type PluginTaskDataControllerRevokeInput,
  revokePluginTaskDataController,
} from './plugin-task-data-controller.js';
import type { PluginTaskAdmissionServices } from './plugin-task-data-services.js';
import { assertPluginTaskGovernance } from './plugin-task-governance.js';
import { type PluginTaskReadItem, projectOwnedPluginTasks } from './plugin-task-read.js';
import { setPluginTaskWait } from './plugin-task-wait.js';

const TASK_KINDS = new Set<TaskKind>(['work', 'pr_tracking', 'issue_tracking']);
const TASK_STATUSES = new Set<TaskStatus>(['todo', 'doing', 'blocked', 'done']);

export interface PluginTaskCreateInput {
  readonly entrustedWork?: PluginTaskWorkData;
  readonly threadId: string;
  readonly title: string;
  readonly why?: string;
  readonly kind?: TaskKind;
  readonly subjectKey?: string | null;
  readonly ownerCatId?: string | null;
}

export interface PluginTaskFieldsPatch {
  readonly entrustedWork?: PluginTaskWorkMutation;
  readonly title?: string;
  readonly status?: TaskStatus;
  readonly why?: string;
  readonly ownerCatId?: string | null;
  readonly threadId?: string;
}

export type PluginTaskUpdateInput =
  | (PluginTaskFieldsPatch & { readonly wait?: never })
  | ({ readonly wait: PluginWaitUpdate } & { readonly [K in keyof PluginTaskFieldsPatch]?: never });
export type PluginTaskSelector =
  | { readonly id: string; readonly subjectKey?: never }
  | { readonly subjectKey: string; readonly id?: never };
export interface PluginTaskFilter {
  readonly threadId?: string;
  readonly kind?: TaskKind;
}
export interface PluginTaskCreateOptions {
  readonly onConflict?: 'error' | 'update';
}
export interface PluginTaskUpdateConditions {
  readonly expectedThreadId?: string;
}

export interface PluginTaskHost {
  get(selector: PluginTaskSelector): Promise<PluginTaskReadItem | null>;
  list(filter: PluginTaskFilter): Promise<readonly PluginTaskReadItem[]>;
  create(input: PluginTaskCreateInput, options?: PluginTaskCreateOptions): Promise<TaskItem>;
  update(
    taskId: string,
    patch: PluginTaskUpdateInput,
    conditions?: PluginTaskUpdateConditions,
  ): Promise<TaskItem | null>;
  bindDataController(input: PluginTaskDataControllerBindInput): Promise<PluginTaskDataControllerMutationResult>;
  revokeDataController(input: PluginTaskDataControllerRevokeInput): Promise<PluginTaskDataControllerMutationResult>;
}

export interface PluginTaskHostDeps {
  readonly artifactReader?: import('../../../growing/ports/PreparedArtifactReader.js').PreparedArtifactReader;
  readonly onTaskDataChanged?: (task: TaskItem) => void;
  readonly admission?: PluginTaskAdmissionServices;
  readonly pluginInstanceId?: string;
  readonly pluginId: string;
  readonly taskStore: ITaskStore | undefined;
  readonly threadStore?: Pick<IThreadStore, 'get'>;
  readonly readThreadStore?: Pick<IThreadStore, 'get'> & Partial<Pick<IThreadStore, 'ensureOwnedThread'>>;
  readonly ownerUserId?: string;
  readonly assertCurrent?: () => void | Promise<void>;
}

function objectKeys(value: unknown, allowed: readonly string[], name: string): void {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  ) {
    throw new TypeError(`${name} must be an object with supported fields`);
  }
}

function boundedString(value: unknown, field: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > maximum) {
    throw new TypeError(`${field} must be a string between ${allowEmpty ? 0 : 1} and ${maximum} characters`);
  }
  return value;
}

function ownerCatId(value: unknown): CatId | null | undefined {
  if (value === undefined || value === null) return value;
  return boundedString(value, 'ownerCatId', 256) as CatId;
}

function createInput(value: PluginTaskCreateInput): CreateTaskInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('task input must be an object');
  const kind = value.kind ?? 'work';
  if (!TASK_KINDS.has(kind)) throw new TypeError('task kind is invalid');
  const subjectKey = value.subjectKey;
  if (subjectKey !== undefined && subjectKey !== null) boundedString(subjectKey, 'subjectKey', 500);
  const owner = ownerCatId(value.ownerCatId);
  return {
    threadId: boundedString(value.threadId, 'threadId', 500),
    title: boundedString(value.title, 'title', 200),
    why: boundedString(value.why ?? '', 'why', 1_000, true),
    createdBy: 'system',
    kind,
    ...(subjectKey === undefined ? {} : { subjectKey }),
    ...(owner === undefined ? {} : { ownerCatId: owner }),
  };
}

function updateInput(value: PluginTaskFieldsPatch): UpdateTaskInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('task patch must be an object');
  const result: UpdateTaskInput = {};
  if (value.title !== undefined) result.title = boundedString(value.title, 'title', 200);
  if (value.status !== undefined) {
    if (!TASK_STATUSES.has(value.status)) throw new TypeError('task status is invalid');
    result.status = value.status;
  }
  if (value.why !== undefined) result.why = boundedString(value.why, 'why', 1_000, true);
  if (value.threadId !== undefined) result.threadId = boundedString(value.threadId, 'threadId', 500);
  const owner = ownerCatId(value.ownerCatId);
  if (owner !== undefined) result.ownerCatId = owner;
  if (Object.keys(result).length === 0) throw new TypeError('task patch must contain at least one supported field');
  return result;
}

function taskKind(value: unknown): TaskKind {
  if (typeof value !== 'string' || !TASK_KINDS.has(value as TaskKind)) throw new TypeError('task kind is invalid');
  return value as TaskKind;
}

function subjectUpsertInput(value: PluginTaskCreateInput): CreateTaskInput {
  const input = createInput(value);
  if (!input.subjectKey) throw new TypeError('subjectKey is required for task upsert');
  return input;
}

export function createPluginTaskHost(input: PluginTaskHostDeps): PluginTaskHost {
  const readOwnerUserId = input.ownerUserId;
  const assertCurrentCall = () => currentPluginCallContext(input.pluginInstanceId)?.assertCurrent();
  const requireService = () => {
    if (!input.taskStore) {
      throw new ExternalPluginRuntimeError('UNSUPPORTED_TRANSPORT', 'Host task store is unavailable');
    }
    return input.taskStore;
  };
  const withCallerUser = (value: CreateTaskInput): CreateTaskInput => {
    const caller = currentPluginCallContext(input.pluginInstanceId);
    return caller ? { ...value, userId: caller.userId } : value;
  };
  const authorizeTask = async (task: Pick<CreateTaskInput, 'kind' | 'threadId' | 'subjectKey'>) => {
    await assertPluginTaskGovernance(
      requireService(),
      input.threadStore,
      task,
      currentPluginCallContext(input.pluginInstanceId)?.threadId,
    );
    await assertCurrentCall();
  };
  const read = async (
    operation: (store: ITaskStore) => readonly TaskItem[] | Promise<readonly TaskItem[]>,
  ): Promise<readonly PluginTaskReadItem[]> => {
    const store = requireService();
    if (!readOwnerUserId)
      throw new ExternalPluginRuntimeError('UNSUPPORTED_TRANSPORT', 'Host task owner is unavailable');
    const native = currentPluginCallContext(input.pluginInstanceId);
    const owner = input.pluginInstanceId ? currentPluginOwnerRequestContext(input.pluginInstanceId) : undefined;
    if ((native && native.userId !== readOwnerUserId) || (owner && owner.userId !== readOwnerUserId))
      throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', 'Task caller does not match installation owner');
    const current = async () => {
      requireService();
      await input.assertCurrent?.();
      await native?.assertCurrent();
      await owner?.assertCurrent();
      await input.assertCurrent?.();
      requireService();
    };
    const once = async () => {
      await current();
      const tasks = structuredClone(await operation(store));
      await current();
      const controllerCurrency = await currentTaskDataControllerProjection(
        tasks,
        input.pluginInstanceId,
        input.admission,
      );
      await current();
      const result = await projectOwnedPluginTasks(
        tasks,
        readOwnerUserId,
        input.readThreadStore,
        controllerCurrency,
        input.admission?.messageStore,
      );
      await current();
      return result;
    };
    const before = await once();
    const after = await once();
    if (!isDeepStrictEqual(before, after))
      throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', 'Task read changed while checking ownership');
    return after;
  };
  return {
    bindDataController: (value) => bindPluginTaskDataController(input, value),
    revokeDataController: (value) => revokePluginTaskDataController(input, value),
    get: async (selector) => {
      objectKeys(selector, ['id', 'subjectKey'], 'task selector');
      if (Object.keys(selector).length !== 1)
        throw new TypeError('task selector requires exactly one id or subjectKey');
      const byId = Object.hasOwn(selector, 'id');
      const key = boundedString(byId ? selector.id : selector.subjectKey, 'task selector', 500);
      const tasks = await read(async (store) => {
        const task = await (byId ? store.get(key) : store.getBySubject(key));
        return task ? [task] : [];
      });
      return tasks[0] ?? null;
    },
    list: async (filter) => {
      objectKeys(filter, ['threadId', 'kind'], 'task filter');
      const threadId = filter.threadId === undefined ? undefined : boundedString(filter.threadId, 'threadId', 500);
      const kind = filter.kind === undefined ? undefined : taskKind(filter.kind);
      return read(async (store) => {
        const tasks =
          threadId !== undefined
            ? await store.listByThread(threadId)
            : kind !== undefined
              ? await store.listByKind(kind)
              : (await Promise.all([...TASK_KINDS].map((k) => store.listByKind(k)))).flat();
        return kind === undefined ? tasks : tasks.filter((task) => task.kind === kind);
      });
    },
    create: async (value, options = {}) => {
      objectKeys(options, ['onConflict'], 'task create options');
      const mode = options.onConflict ?? 'error';
      if (mode !== 'error' && mode !== 'update') throw new TypeError('onConflict must be error or update');
      const store = requireService();
      await assertCurrentCall();
      const task = withCallerUser(mode === 'update' ? subjectUpsertInput(value) : createInput(value));
      await authorizeTask(task);
      if (value.entrustedWork !== undefined) return createPluginTaskWorkData(input, task, value.entrustedWork, mode);
      if (mode === 'error') return store.create(task);
      for (let attempt = 0; ; attempt++) {
        // Snapshot before authorization, including absence. The store must fence this exact
        // aggregate at the write, since upsert retains its kind rather than the input kind.
        const expected = structuredClone(await store.getBySubject(task.subjectKey!));
        await authorizeTask(task);
        if (expected) await authorizeTask({ ...expected, threadId: task.threadId });
        await assertCurrentCall();
        try {
          return await store.upsertBySubject(task, { expected });
        } catch (error) {
          if (!isTaskSubjectSnapshotConflictError(error) || attempt >= 2) throw error;
        }
      }
    },
    update: async (taskId, value, conditions = {}) => {
      objectKeys(conditions, ['expectedThreadId'], 'task update conditions');
      objectKeys(value, ['wait', 'entrustedWork', 'title', 'status', 'why', 'ownerCatId', 'threadId'], 'task patch');
      const expected =
        conditions.expectedThreadId === undefined
          ? undefined
          : boundedString(conditions.expectedThreadId, 'expectedThreadId', 500);
      const store = requireService();
      await assertCurrentCall();
      const id = boundedString(taskId, 'taskId', 500);
      if (Object.hasOwn(value, 'wait')) {
        if (Object.keys(value).length !== 1) throw new TypeError('wait must be the only task patch field');
        return setPluginTaskWait(
          store,
          input.pluginInstanceId,
          currentPluginCallContext(input.pluginInstanceId),
          id,
          value.wait!,
          authorizeTask,
          expected,
        );
      }
      if (value.entrustedWork !== undefined) return updatePluginTaskWorkData(input, id, value, expected);
      const patch = updateInput(value);
      const task = await store.get(id);
      if (!task || (expected !== undefined && task.threadId !== expected)) return null;
      if (patch.threadId !== undefined || (patch.status !== undefined && patch.status !== 'done')) {
        await authorizeTask({ ...task, threadId: patch.threadId ?? task.threadId });
      }
      await assertCurrentCall();
      return store.updateIfThreadId(id, expected ?? task.threadId, patch);
    },
  };
}
