import { createHash } from 'node:crypto';
import {
  type OwnerTruthRefV1,
  ownerTruthRefV1Schema,
  type TaskItem,
  type TaskKind,
  taskFeatureIdSchema,
} from '@cat-cafe/shared';
import type { ITaskStore } from './TaskStoreContract.js';

export const TASK_QUERY_MAX_RESULTS = 50;

export interface TaskQueryFilters {
  readonly threadIds: readonly string[];
  readonly ownerUserId: string;
  readonly catId?: string;
  readonly status?: TaskItem['status'];
  readonly kind?: TaskKind;
  readonly taskId?: string;
  readonly featureId?: string;
}

export interface TaskQueryResult {
  readonly tasks: readonly TaskItem[];
  readonly totalMatched: number;
  readonly truncated: boolean;
  readonly queryRef?: OwnerTruthRefV1;
}

function canonicalThreadIds(threadIds: readonly string[]): string[] {
  return [...new Set(threadIds.map((threadId) => threadId.trim()).filter(Boolean))].sort();
}

function canonicalOptional<T>(value: T | undefined): T | null {
  return value === undefined ? null : value;
}

function deriveFeatureQueryRef(
  filters: TaskQueryFilters,
  threadIds: readonly string[],
  matched: readonly TaskItem[],
): OwnerTruthRefV1 | undefined {
  if (!filters.featureId) return undefined;
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        query: {
          threadIds,
          ownerUserId: filters.ownerUserId,
          featureId: filters.featureId,
          catId: canonicalOptional(filters.catId),
          status: canonicalOptional(filters.status),
          kind: canonicalOptional(filters.kind),
          taskId: canonicalOptional(filters.taskId),
        },
        matches: matched.map((task) => [
          task.id,
          task.threadId,
          canonicalOptional(task.ownerCatId),
          task.status,
          task.kind,
          canonicalOptional(task.relatedFeatureId),
          task.updatedAt,
        ]),
      }),
    )
    .digest('hex');
  return ownerTruthRefV1Schema.parse({
    ownerFeatureId: 'F160',
    ownerStateRef: `task-query:feature:${filters.featureId}:sha256:${digest}`,
    version: '1',
  });
}

/** Canonical filtering, ordering, response bound, and feature-query identity for every task read surface. */
export async function queryTaskItems(
  taskStore: Pick<ITaskStore, 'listByThread'>,
  filters: TaskQueryFilters,
): Promise<TaskQueryResult> {
  if (!filters.ownerUserId || filters.ownerUserId !== filters.ownerUserId.trim()) {
    throw new Error('task query ownerUserId must be a non-empty canonical identity');
  }
  if (filters.featureId !== undefined) {
    taskFeatureIdSchema.parse(filters.featureId);
  }
  const threadIds = canonicalThreadIds(filters.threadIds);
  const perThreadTasks = await Promise.all(threadIds.map((threadId) => taskStore.listByThread(threadId)));
  let matched = perThreadTasks.flat().filter((task) => task.userId === filters.ownerUserId);
  if (filters.catId) matched = matched.filter((task) => task.ownerCatId === filters.catId);
  if (filters.status) matched = matched.filter((task) => task.status === filters.status);
  if (filters.kind) matched = matched.filter((task) => task.kind === filters.kind);
  if (filters.taskId) matched = matched.filter((task) => task.id === filters.taskId);
  if (filters.featureId) matched = matched.filter((task) => task.relatedFeatureId === filters.featureId);
  matched.sort(
    (left, right) =>
      right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || right.id.localeCompare(left.id),
  );

  const totalMatched = matched.length;
  const tasks = matched.slice(0, TASK_QUERY_MAX_RESULTS);
  const queryRef = deriveFeatureQueryRef(filters, threadIds, matched);
  return {
    tasks,
    totalMatched,
    truncated: totalMatched > tasks.length,
    ...(queryRef ? { queryRef } : {}),
  };
}
