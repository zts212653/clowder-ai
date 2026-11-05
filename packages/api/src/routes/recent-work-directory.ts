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
import { directoryNextSources, directoryTopicTerms, threadTopicMatch } from './recent-work-topic.js';

export const DIRECTORY_MAX_CHARS = 24_000;
const DIRECTORY_READ_BUDGET_MS = 3_000;
const TOPIC_THREAD_SCAN_LIMIT = 40;
const cursorSchema = z
  .object({
    v: z.literal(1),
    asOf: z.number().finite(),
    time: z.number().finite(),
    id: z.string().max(300),
    selector: z.string().length(64),
    inclusive: z.literal(true).optional(),
    partial: z.literal(true).optional(),
  })
  .strict();
export class DirectoryCursorError extends Error {}

interface DirectoryInput extends DirectoryReadSources {
  threadStore: IThreadStore;
  limit?: number;
  activeSince?: number;
  keyword?: string;
  topic?: string;
  cursor?: string;
}
function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** On-demand projection only; Thread, Task and lifecycle sources retain all state ownership. */
export async function readRecentWorkDirectory(input: DirectoryInput) {
  const observedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error('Work directory read budget exhausted')),
    DIRECTORY_READ_BUDGET_MS,
  );
  const signal = controller.signal;
  try {
    const topicTerms = directoryTopicTerms(input.topic);
    if (input.topic && (!topicTerms.length || input.keyword)) {
      throw new DirectoryCursorError('topic requires short clues and includeWork=true; use topic or keyword, not both');
    }
    const selector = createHash('sha256')
      .update(
        JSON.stringify([
          input.userId,
          input.activeSince ?? null,
          input.keyword?.toLowerCase() ?? null,
          ...(topicTerms.length ? [topicTerms] : []),
        ]),
      )
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
            (cursor.inclusive && thread.lastActiveAt === cursor.time && thread.id === cursor.id) ||
            (thread.lastActiveAt === cursor.time && thread.id.localeCompare(cursor.id) > 0)),
      )
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt || a.id.localeCompare(b.id));
    const pageLimit = Math.min(input.limit ?? 20, 20);
    const detailsAuthorized = hasDirectoryTaskAuthority(input);
    const roadmapAuthorized = hasDirectorySourceAuthority(input, 'GET /api/callbacks/thread-metadata');
    const roadmapCache: RoadmapReadCache = new Map();
    const prepared = [];
    const fallbackThreads = [];
    let scanned = 0;
    let taskReads = 0;
    let partialTasks = false;
    let partialRoadmaps = false;
    let resumeFrom: number | undefined;
    let unverifiedBefore = cursor?.partial === true;
    const scanLimit = topicTerms.length ? TOPIC_THREAD_SCAN_LIMIT : pageLimit;
    for (const thread of candidates.slice(0, scanLimit)) {
      if (signal.aborted) break;
      const position = scanned++;
      const access = await resolveThreadAccess({
        threadStore: { list: () => visible },
        thread,
        userId: input.userId,
        request: { resource: 'executions', action: 'read' },
      });
      const tasks =
        access.status === 200
          ? await readDirectoryTasks(input, thread, signal, visibleThreadIds, topicTerms)
          : undefined;
      if (!tasks) {
        unverifiedBefore = true;
        continue;
      }
      taskReads++;
      if (tasks.summary.status !== 'available') partialTasks = true;
      const roadmap =
        roadmapAuthorized && thread.threadMetadata?.roadmap
          ? await readThreadRoadmap({
              thread,
              threadStore: input.threadStore,
              userId: input.userId,
              signal,
              cache: roadmapCache,
            })
          : undefined;
      if (roadmap?.status === 'unavailable') partialRoadmaps = true;
      // An interrupted source has not been consumed, including the first thread.
      // Retry it on the next bounded call rather than losing its Task evidence.
      if (signal.aborted) {
        resumeFrom = position;
        break;
      }
      if (tasks.summary.status !== 'available' || roadmap?.status === 'unavailable') unverifiedBefore = true;
      const topicMatch = threadTopicMatch(
        thread,
        topicTerms,
        tasks.matching.flatMap((task) => task.sources),
        roadmap,
      );
      if (topicTerms.length && topicMatch.sources.length === 0) {
        if (fallbackThreads.length < 3)
          fallbackThreads.push({
            threadId: thread.id,
            title: clip(thread.title ?? '（未命名）', 200),
            match: 'unassessed',
            drillDown: { tool: 'cat_cafe_get_thread_context', args: { threadId: thread.id } },
          });
        continue;
      }
      prepared.push({ thread, tasks, topicMatch, roadmap, position });
      if (prepared.length >= pageLimit) break;
    }
    const running = await runningPromise;
    const threads = [];
    let consumed = resumeFrom ?? scanned;
    for (const { thread, tasks, topicMatch, roadmap, position } of prepared) {
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
        ...(roadmap
          ? { roadmap }
          : !roadmapAuthorized
            ? { roadmap: { status: 'unavailable', reason: 'not_authorized' } }
            : {}),
        drillDown: { tool: 'cat_cafe_get_thread_context', args: { threadId: thread.id } },
        ...(topicTerms.length
          ? {
              topicMatch,
              matchingTasks: tasks.matching,
              readNext: {
                tool: 'cat_cafe_get_thread_context',
                args: {
                  threadId: thread.id,
                  keyword: topicTerms.join(' '),
                  responseMode: 'full',
                  limit: 20,
                },
              },
            }
          : {}),
      };
      // Reserve envelope/cursor room. A single current validated Thread/Task entry fits this budget.
      if (JSON.stringify([...threads, entry]).length > DIRECTORY_MAX_CHARS - 4_000) {
        consumed = position;
        break;
      }
      threads.push(entry);
    }
    const hasMore = consumed < candidates.length;
    const last = consumed === 0 ? candidates[0] : candidates[consumed - 1];
    return {
      scope: 'visible_threads',
      asOf,
      observedAt,
      consistency: 'live_with_activity_cutoff',
      pageLimit,
      threads,
      hasMore,
      discovery: {
        state: threads.length ? 'candidates' : 'no_match_in_checked_scope',
        originalContentRead: false,
        ...(topicTerms.length ? { topicTerms } : {}),
        coverage: {
          scope: 'eligible_thread_titles_and_task_metadata',
          threadsScanned: scanned,
          complete:
            !hasMore && !signal.aborted && detailsAuthorized && !partialTasks && !partialRoadmaps && !unverifiedBefore,
          ...(cursor?.partial ? { priorPagesPartial: true } : {}),
          tasks: !detailsAuthorized
            ? 'not_authorized'
            : !taskReads
              ? 'not_checked'
              : partialTasks
                ? 'partial'
                : 'checked',
          roadmap: !roadmapAuthorized ? 'not_authorized' : partialRoadmaps ? 'partial' : 'checked_pointers',
          budget: { threadLimit: scanLimit, timeLimitMs: DIRECTORY_READ_BUDGET_MS, elapsedMs: Date.now() - observedAt },
          works: 'not_checked',
          messages: 'not_searched',
          evidenceIndex: 'not_checked',
          matters: 'not_checked',
          ...(signal.aborted ? { reason: 'budget_exhausted' } : {}),
        },
      },
      ...(topicTerms.length && !threads.length ? { fallbackThreads } : {}),
      nextSources: directoryNextSources(input.topic),
      guidance:
        '候选只来自本次已检查的元数据，不表示原文已读、适用或获准施工。没有Matter页也可从Thread/Task/Work/roadmap回原入口；字面未命中不等于不存在，fallbackThreads仅为未评相关性的近期入口。按当前标题与原问题选择短topic，或续nextCursor、查nextSources；未检查的消息/索引/Work范围保持未知。先读当前原话再用于回答，读取/版本以原工具回执为准。续页排除asOf后的新活动；需最新情况请重新查询。责任看原Task，文件读取独立鉴权，不自动跟随文档链接。',
      ...(hasMore && last
        ? {
            nextCursor: Buffer.from(
              JSON.stringify({
                v: 1,
                asOf,
                time: last.lastActiveAt,
                id: last.id,
                selector,
                ...(consumed === 0 ? { inclusive: true } : {}),
                ...(unverifiedBefore ? { partial: true } : {}),
              }),
            ).toString('base64url'),
          }
        : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}
