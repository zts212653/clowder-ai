import { createHash } from 'node:crypto';
import { z } from 'zod';
import { resolveThreadAccess } from '../domains/cats/services/session/thread-access-policy.js';
import { awaitStoreRead } from '../domains/cats/services/stores/ports/StoreReadOptions.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { type RoadmapReadCache, readThreadRoadmap } from '../domains/workspace/thread-roadmap-source.js';
import {
  type DirectoryReadSources,
  hasDirectorySourceAuthority,
  hasDirectoryTaskAuthority,
  projectDirectoryExecution,
  readDirectoryRunningWork,
  readDirectoryTasks,
} from './recent-work-directory-sources.js';

export const DIRECTORY_MAX_CHARS = 24_000;
const cursorSchema = z
  .object({
    v: z.literal(1),
    asOf: z.number().finite(),
    time: z.number().finite(),
    id: z.string().max(300),
    selector: z.string().length(64),
  })
  .strict();
export class DirectoryCursorError extends Error {}

interface DirectoryInput extends DirectoryReadSources {
  threadStore: IThreadStore;
  limit?: number;
  activeSince?: number;
  keyword?: string;
  cursor?: string;
}
function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** On-demand projection only; Thread, Task and lifecycle sources retain all state ownership. */
export async function readRecentWorkDirectory(input: DirectoryInput) {
  const observedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Work directory read budget exhausted')), 3_000);
  const signal = controller.signal;
  try {
    const selector = createHash('sha256')
      .update(JSON.stringify([input.userId, input.activeSince ?? null, input.keyword?.toLowerCase() ?? null]))
      .digest('hex');
    let cursor: z.infer<typeof cursorSchema> | undefined;
    if (input.cursor) {
      try {
        cursor = cursorSchema.parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')));
        if (cursor.selector !== selector) throw new Error('selector mismatch');
      } catch {
        throw new DirectoryCursorError('Invalid work-directory cursor; restart with the same filters');
      }
    }
    const asOf = cursor?.asOf ?? observedAt;
    if (asOf > observedAt) throw new DirectoryCursorError('Work-directory cursor cutoff is in the future');
    const visible = await awaitStoreRead(Promise.resolve(input.threadStore.list(input.userId, { signal })), { signal });
    const visibleThreadIds = new Set(visible.filter((thread) => !thread.deletedAt).map((thread) => thread.id));
    const runningPromise = readDirectoryRunningWork(input, signal);
    const needle = input.keyword?.toLowerCase();
    const candidates = visible
      .filter(
        (thread) =>
          !thread.deletedAt &&
          thread.lastActiveAt <= asOf &&
          (input.activeSince === undefined || thread.lastActiveAt >= input.activeSince) &&
          (!needle ||
            (thread.title ?? '').toLowerCase().includes(needle) ||
            (needle.startsWith('thread_') && thread.id.toLowerCase() === needle)) &&
          (!cursor ||
            thread.lastActiveAt < cursor.time ||
            (thread.lastActiveAt === cursor.time && thread.id.localeCompare(cursor.id) > 0)),
      )
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt || a.id.localeCompare(b.id));
    const pageLimit = Math.min(input.limit ?? 20, 20);
    const prepared = [];
    for (const thread of candidates.slice(0, pageLimit)) {
      const access = await resolveThreadAccess({
        threadStore: { list: () => visible },
        thread,
        userId: input.userId,
        request: { resource: 'executions', action: 'read' },
      });
      const tasks =
        access.status === 200 ? await readDirectoryTasks(input, thread, signal, visibleThreadIds) : undefined;
      prepared.push({ thread, tasks });
    }
    const running = await runningPromise;
    const detailsAuthorized = hasDirectoryTaskAuthority(input);
    const roadmapAuthorized = hasDirectorySourceAuthority(input, 'GET /api/callbacks/thread-metadata');
    const roadmapCache: RoadmapReadCache = new Map();
    const threads = [];
    let consumed = 0;
    for (const { thread, tasks } of prepared) {
      if (!tasks) {
        consumed++;
        continue;
      }
      const recentTasks = tasks.summary;
      const execution = await projectDirectoryExecution(
        thread,
        tasks.links,
        running.data,
        running.reason,
        visible,
        signal,
      );
      const entry = {
        threadId: thread.id,
        title: clip(thread.title ?? '（未命名）', 200),
        projectPath: detailsAuthorized && thread.projectPath.length <= 1_000 ? thread.projectPath : null,
        ...(!detailsAuthorized
          ? { projectPathStatus: 'not_authorized' }
          : thread.projectPath.length > 1_000
            ? { projectPathStatus: 'coordinate_exceeds_budget' }
            : {}),
        lastActiveAt: thread.lastActiveAt,
        recentTasks,
        execution,
        ...(roadmapAuthorized && thread.threadMetadata?.roadmap
          ? {
              roadmap: await readThreadRoadmap({
                thread,
                threadStore: input.threadStore,
                userId: input.userId,
                signal,
                cache: roadmapCache,
              }),
            }
          : !roadmapAuthorized
            ? { roadmap: { status: 'unavailable', reason: 'not_authorized' } }
            : {}),
        drillDown: { tool: 'cat_cafe_get_thread_context', args: { threadId: thread.id } },
      };
      // Reserve envelope/cursor room. A single current validated Thread/Task entry fits this budget.
      if (JSON.stringify([...threads, entry]).length > DIRECTORY_MAX_CHARS - 1_000) break;
      threads.push(entry);
      consumed++;
    }
    const hasMore = consumed < candidates.length;
    const last = candidates[consumed - 1];
    return {
      scope: 'visible_threads',
      asOf,
      observedAt,
      consistency: 'live_with_activity_cutoff',
      pageLimit,
      threads,
      hasMore,
      guidance:
        '按标题+毛线球认线；近期没找到不等于不存在。续页排除asOf后的新活动；需最新情况请重新查询。认线后按需读精确Task或roadmap，发现不等于接手，责任看原Task。文件读工具独立鉴权；不自动跟随文档内的链接。',
      ...(hasMore && last
        ? {
            nextCursor: Buffer.from(
              JSON.stringify({ v: 1, asOf, time: last.lastActiveAt, id: last.id, selector }),
            ).toString('base64url'),
          }
        : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}
