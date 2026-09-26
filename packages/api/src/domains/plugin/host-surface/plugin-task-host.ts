import type { CatId, CreateTaskInput, TaskItem, TaskKind, TaskStatus, UpdateTaskInput } from '@cat-cafe/shared';
import type { ITaskStore } from '../../cats/services/stores/ports/TaskStore.js';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';

const TASK_KINDS = new Set<TaskKind>(['work', 'pr_tracking', 'issue_tracking']);
const TASK_STATUSES = new Set<TaskStatus>(['todo', 'doing', 'blocked', 'done']);

export interface PluginTaskCreateInput {
  readonly threadId: string;
  readonly title: string;
  readonly why?: string;
  readonly kind?: TaskKind;
  readonly subjectKey?: string | null;
  readonly ownerCatId?: string | null;
}

export interface PluginTaskUpdateInput {
  readonly title?: string;
  readonly status?: TaskStatus;
  readonly why?: string;
  readonly ownerCatId?: string | null;
  readonly threadId?: string;
}

export interface PluginTaskHost {
  get(taskId: string): Promise<TaskItem | null>;
  listByThread(threadId: string): Promise<readonly TaskItem[]>;
  listByKind(kind: TaskKind): Promise<readonly TaskItem[]>;
  getBySubject(subjectKey: string): Promise<TaskItem | null>;
  create(input: PluginTaskCreateInput): Promise<TaskItem>;
  upsertBySubject(input: PluginTaskCreateInput): Promise<TaskItem>;
  update(taskId: string, input: PluginTaskUpdateInput): Promise<TaskItem | null>;
  updateIfThreadId(taskId: string, expectedThreadId: string, input: PluginTaskUpdateInput): Promise<TaskItem | null>;
}

export interface PluginTaskHostDeps {
  readonly pluginId: string;
  readonly effectiveGrants: readonly string[];
  readonly taskStore: ITaskStore | undefined;
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

function updateInput(value: PluginTaskUpdateInput): UpdateTaskInput {
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
  const requireGrant = (capability: 'task.read' | 'task.write') => {
    if (!input.effectiveGrants.includes(capability)) {
      throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', `${input.pluginId} lacks ${capability}`);
    }
    if (!input.taskStore) {
      throw new ExternalPluginRuntimeError('UNSUPPORTED_TRANSPORT', 'Host task store is unavailable');
    }
    return input.taskStore;
  };
  return {
    get: async (taskId) => requireGrant('task.read').get(boundedString(taskId, 'taskId', 500)),
    listByThread: async (threadId) => requireGrant('task.read').listByThread(boundedString(threadId, 'threadId', 500)),
    listByKind: async (kind) => requireGrant('task.read').listByKind(taskKind(kind)),
    getBySubject: async (subjectKey) =>
      requireGrant('task.read').getBySubject(boundedString(subjectKey, 'subjectKey', 500)),
    create: async (value) => requireGrant('task.write').create(createInput(value)),
    upsertBySubject: async (value) => requireGrant('task.write').upsertBySubject(subjectUpsertInput(value)),
    update: async (taskId, value) =>
      requireGrant('task.write').update(boundedString(taskId, 'taskId', 500), updateInput(value)),
    updateIfThreadId: async (taskId, expectedThreadId, input) =>
      requireGrant('task.write').updateIfThreadId(
        boundedString(taskId, 'taskId', 500),
        boundedString(expectedThreadId, 'expectedThreadId', 500),
        updateInput(input),
      ),
  };
}
