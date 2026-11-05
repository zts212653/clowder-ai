import type { TaskItem } from '@cat-cafe/shared';
import { z } from 'zod';
import type { InvocationRecord } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import { toolExecutionPolicyDenial } from '../domains/cats/services/agents/invocation/tool-execution-policy.js';
import { awaitStoreRead } from '../domains/cats/services/stores/ports/StoreReadOptions.js';
import { compareTaskQueryRecency, taskBelongsToQueryOwner } from '../domains/cats/services/stores/ports/TaskQuery.js';
import type { ITaskStore } from '../domains/cats/services/stores/ports/TaskStore.js';
import type { Thread } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { migrateStoredProjectPath } from '../utils/persistent-project-path.js';

const TASK_PAGE_SIZE = 100;
const TASK_PAGE_BUDGET = 5;
const RUNNING_READ_BUDGET_MS = 750;
const runningWorkSchema = z.object({
  status: z.literal('available'),
  scope: z.literal('host_active_project'),
  projectPath: z.string(),
  observedAt: z.number(),
  groups: z.array(z.object({ threadId: z.string(), catId: z.string() })),
});
type RunningWork = z.infer<typeof runningWorkSchema>;
interface ExecutionLinks {
  threadIds: Set<string>;
  complete: boolean;
}

export interface DirectoryReadSources {
  userId: string;
  taskStore?: ITaskStore;
  /** Original server-authenticated record, never an input flag from a tool caller. */
  invocationAuthority?: Pick<InvocationRecord, 'userId' | 'toolExecutionPolicy'>;
  readRunningWork: () => Promise<{ statusCode: number; body: unknown }>;
}

export function hasDirectoryTaskAuthority(input: DirectoryReadSources): boolean {
  return hasDirectorySourceAuthority(input, 'GET /api/callbacks/list-tasks');
}

export function hasDirectorySourceAuthority(input: DirectoryReadSources, route: string): boolean {
  const authority = input.invocationAuthority;
  return Boolean(
    authority &&
      authority.userId === input.userId &&
      input.userId &&
      !toolExecutionPolicyDenial(authority.toolExecutionPolicy, route),
  );
}

function taskPointer(task: TaskItem, visible: ReadonlySet<string>) {
  const dispatchedThreadId =
    task.dispatchGate?.status === 'dispatched' ? task.dispatchGate.dispatchedThreadId : undefined;
  return {
    id: task.id,
    kind: task.kind,
    title: task.title.length > 240 ? `${task.title.slice(0, 239)}…` : task.title,
    status: task.status,
    ownerCatId: task.ownerCatId,
    updatedAt: task.updatedAt,
    ...(task.title.length > 240 ? { titleTruncated: true } : {}),
    drillDown: { tool: 'cat_cafe_list_tasks', args: { threadId: task.threadId, taskId: task.id } },
    ...(dispatchedThreadId && visible.has(dispatchedThreadId) ? { dispatchedThreadId } : {}),
  };
}

export async function readDirectoryTasks(
  input: DirectoryReadSources,
  thread: Thread,
  signal: AbortSignal,
  visible: ReadonlySet<string>,
) {
  const links: ExecutionLinks = { threadIds: new Set(), complete: true };
  const unavailable = (reason: string) => ({
    summary: { status: 'unavailable' as const, reason },
    links: { ...links, complete: false },
  });
  if (!hasDirectoryTaskAuthority(input)) return unavailable('not_authorized');
  const readPage = input.taskStore?.listByThreadPage?.bind(input.taskStore);
  if (!readPage) return unavailable('source_unavailable');
  const items = new Map<string, TaskItem>();
  let complete = false;
  let reason = 'budget_exhausted';
  try {
    let cursor: string | undefined;
    for (let pageNo = 0; pageNo < TASK_PAGE_BUDGET; pageNo++) {
      signal.throwIfAborted();
      const page = await awaitStoreRead(Promise.resolve(readPage(thread.id, TASK_PAGE_SIZE, cursor)), { signal });
      for (const task of page.tasks) {
        if (task.threadId !== thread.id || task.status === 'done' || !taskBelongsToQueryOwner(task, input.userId))
          continue;
        items.set(task.id, task);
        const executionThread =
          task.dispatchGate?.status === 'dispatched' ? task.dispatchGate.dispatchedThreadId : undefined;
        if (executionThread && visible.has(executionThread)) links.threadIds.add(executionThread);
        else if (executionThread) links.complete = false;
        // A dispatch records a routing destination, not the entrusted execution's current location.
        if (task.entrustedWork) links.complete = false;
      }
      if (!page.nextCursor) {
        complete = true;
        break;
      }
      if (page.nextCursor === cursor) break;
      cursor = page.nextCursor;
    }
  } catch {
    reason = signal.aborted ? 'budget_exhausted' : 'source_error';
    if (items.size === 0) return unavailable(reason);
  }
  if (!complete) links.complete = false;
  return {
    summary: {
      status: complete ? ('available' as const) : ('partial' as const),
      order: complete ? 'updatedAt_desc' : 'updatedAt_desc_within_read',
      ...(complete ? { unfinishedTotal: items.size } : { observedUnfinished: items.size, reason }),
      items: [...items.values()]
        .sort(compareTaskQueryRecency)
        .slice(0, 3)
        .map((task) => taskPointer(task, visible)),
    },
    links,
  };
}

/** Runtime health cannot spend the Task read budget; caller starts both sources before awaiting either. */
export async function readDirectoryRunningWork(
  input: DirectoryReadSources,
  parentSignal: AbortSignal,
): Promise<{ data?: RunningWork; reason: string }> {
  if (!hasDirectoryTaskAuthority(input)) return { reason: 'not_authorized' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Running-work budget exhausted')), RUNNING_READ_BUDGET_MS);
  const signal = AbortSignal.any([parentSignal, controller.signal]);
  try {
    signal.throwIfAborted();
    const response = await awaitStoreRead(input.readRunningWork(), { signal });
    if (response.statusCode === 401 || response.statusCode === 403) return { reason: 'not_authorized' };
    if (response.statusCode !== 200) return { reason: 'source_error' };
    return { data: runningWorkSchema.parse(response.body), reason: '' };
  } catch {
    return { reason: signal.aborted ? 'budget_exhausted' : 'source_error' };
  } finally {
    clearTimeout(timer);
  }
}

export async function projectDirectoryExecution(
  thread: Thread,
  links: ExecutionLinks,
  running: RunningWork | undefined,
  reason: string,
  visible: readonly Thread[],
  signal: AbortSignal,
) {
  const unknown = (why: string) => ({ status: 'unavailable' as const, state: 'unknown' as const, reason: why });
  if (!running) return unknown(reason);
  const related = new Set([thread.id, ...links.threadIds]);
  const matches = running.groups.filter((group) => related.has(group.threadId));
  const bounded = matches.slice(0, 16);
  const cats = [...new Set(bounded.map((group) => group.catId))].sort();
  if (cats.length === 0) {
    try {
      signal.throwIfAborted();
      const root = await awaitStoreRead(migrateStoredProjectPath(thread.projectPath), { signal });
      if (root !== running.projectPath) return unknown('outside_host_project');
    } catch {
      return unknown(signal.aborted ? 'budget_exhausted' : 'project_scope_unavailable');
    }
    if (
      !links.complete ||
      visible.some((other) => links.threadIds.has(other.id) && other.projectPath !== thread.projectPath)
    )
      return unknown('task_execution_links_incomplete');
  }
  return {
    status: 'available' as const,
    state: cats.length ? ('running' as const) : ('none' as const),
    runningCatIds: cats,
    runningThreads: bounded,
    truncated: matches.length > bounded.length,
    observedAt: running.observedAt,
    scope: running.scope,
    relatedScope: 'home_and_dispatch_gate',
    executionLinksComplete: links.complete,
  };
}
