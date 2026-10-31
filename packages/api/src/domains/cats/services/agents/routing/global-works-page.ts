import { createHash } from 'node:crypto';
import type { GlobalArtifactDTO, ThreadArtifactDTO } from '@cat-cafe/shared';
import { z } from 'zod';
import type { IMessageStore, StoredMessage } from '../../stores/ports/MessageStore.js';
import type { ITaskStore } from '../../stores/ports/TaskStore.js';
import { TaskPageCursorExpiredError } from '../../stores/ports/TaskStoreContract.js';
import { getTimelineOrderTime } from '../../stores/visibility.js';
import { aggregateProjectedThreadArtifacts, projectMessageArtifactSlice } from './thread-artifacts-aggregator.js';
import { threadWorksPrs } from './thread-works-prs.js';

const positionSchema = z
  .object({ timestamp: z.number().finite().nonnegative(), id: z.string().min(1).max(256) })
  .strict();
const cursorSchema = z
  .object({
    v: z.literal(1),
    owner: z.string().min(1).max(256),
    startedAt: z.number().finite().nonnegative(),
    afterThread: z.string().max(256).optional(),
    current: z
      .object({
        threadId: z.string().min(1).max(256),
        phase: z.enum(['works', 'tasks', 'messages']),
        workAfter: z.string().max(2048).optional(),
        workSnapshot: z.string().max(256).optional(),
        taskAfter: z.string().max(256).optional(),
        before: positionSchema.optional(),
        resume: z
          .object({ id: z.string().max(256), offset: z.number().int().positive(), fingerprint: z.string().length(64) })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
type Cursor = z.infer<typeof cursorSchema>;
type CatalogueThread = { id: string; title?: string | null; createdBy: string; createdAt?: number };

export class WorksPageError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

function decodeCursor(token: string | undefined, owner: string): Cursor {
  if (!token) return { v: 1, owner, startedAt: Date.now() };
  try {
    if (token.length > 4096) throw new Error('oversized cursor');
    const parsed = cursorSchema.parse(JSON.parse(Buffer.from(token, 'base64url').toString('utf8')));
    if (parsed.owner !== owner || parsed.startedAt > Date.now()) throw new Error('cursor owner/cut mismatch');
    return parsed;
  } catch {
    throw new WorksPageError('Invalid works cursor', 400);
  }
}

const fingerprint = (message: StoredMessage) =>
  createHash('sha256')
    .update(JSON.stringify([message.id, message.timestamp, message.extra, message.contentBlocks]))
    .digest('hex');

/** No persisted catalogue/session: only positions over original stores, authorized afresh for each HTTP read. */
export async function readGlobalWorksPage(input: {
  userId: string;
  cursor?: string;
  threads: readonly CatalogueThread[];
  messages?: IMessageStore;
  tasks?: ITaskStore;
  accepted: (threadId: string, messages: readonly StoredMessage[]) => Promise<ThreadArtifactDTO[]>;
  ownedWorks?: (
    threadId: string,
    after?: string,
    snapshot?: string,
  ) => Promise<{
    artifacts: ThreadArtifactDTO[];
    snapshot: string;
    nextCursor?: string;
  }>;
}) {
  if (!input.messages || !input.tasks?.listByThreadPage) throw new WorksPageError('Works source unavailable', 503);
  const readTasks = input.tasks.listByThreadPage.bind(input.tasks);
  const state = decodeCursor(input.cursor, input.userId);
  const threads = input.threads
    .filter(
      (thread) =>
        (thread.createdBy === input.userId || thread.createdBy === 'system') &&
        (thread.createdAt ?? 0) <= state.startedAt,
    )
    .sort((a, b) => b.id.localeCompare(a.id));
  if (state.current && !threads.some((thread) => thread.id === state.current?.threadId))
    throw new WorksPageError('Works cursor no longer accessible; reload catalogue', 409);
  const artifacts: GlobalArtifactDTO[] = [];
  let scannedMessages = 0;
  let scannedTasks = 0;
  let visitedThreads = 0;
  let exhausted = false;
  while (scannedMessages < 128 && artifacts.length < 512 && visitedThreads < 4) {
    const current = state.current;
    const thread = current
      ? threads.find((item) => item.id === current.threadId)
      : threads.find((item) => !state.afterThread || item.id.localeCompare(state.afterThread) < 0);
    if (!thread) {
      exhausted = true;
      break;
    }
    visitedThreads += 1;
    const position = state.current ?? {
      threadId: thread.id,
      phase: input.ownedWorks ? ('works' as const) : ('tasks' as const),
    };
    state.current = position;
    const append = (items: readonly ThreadArtifactDTO[]) =>
      artifacts.push(
        ...items.map((item) => ({
          ...item,
          threadId: thread.id,
          threadTitle: thread.title ?? '',
        })),
      );
    if (position.phase === 'works') {
      if (artifacts.length > 502) break;
      if (!input.ownedWorks) throw new WorksPageError('Work owner source unavailable', 503);
      const page = await input.ownedWorks(thread.id, position.workAfter, position.workSnapshot);
      if (page.artifacts.length > 10 || (page.nextCursor && page.nextCursor === position.workAfter))
        throw new WorksPageError('Invalid owner work page', 503);
      append(page.artifacts);
      if (page.nextCursor) {
        position.workAfter = page.nextCursor;
        position.workSnapshot = page.snapshot;
        break;
      }
      position.phase = 'tasks';
      delete position.workAfter;
      delete position.workSnapshot;
    }
    if (artifacts.length >= 512) break;
    if (position.phase === 'tasks') {
      if (scannedTasks >= 64) break;
      const page = await (async () => {
        try {
          return await readTasks(thread.id, 64 - scannedTasks, position.taskAfter);
        } catch (error) {
          if (error instanceof TaskPageCursorExpiredError)
            throw new WorksPageError('Work attachment changed; reload catalogue', 409);
          throw error;
        }
      })();
      const taskReads = page.scannedCount ?? page.tasks.length;
      if (taskReads > 64 - scannedTasks || taskReads < page.tasks.length)
        throw new WorksPageError('Invalid task page', 503);
      scannedTasks += taskReads;
      if (position.resume && page.tasks[0]?.id !== position.resume.id)
        throw new WorksPageError('Work attachment changed; reload catalogue', 409);
      for (const task of page.tasks) {
        // Complete items have no continuation payload to fingerprint.
        const digest = position.resume ? createHash('sha256').update(JSON.stringify(task)).digest('hex') : undefined;
        if (position.resume && digest !== position.resume.fingerprint)
          throw new WorksPageError('Work attachment changed; reload catalogue', 409);
        const items = aggregateProjectedThreadArtifacts({
          messageArtifacts: [],
          prTasks: threadWorksPrs([task], input.userId, thread.createdBy),
          fileLedger: [],
        });
        const offset = position.resume?.offset ?? 0;
        const selected = items.slice(offset, offset + 512 - artifacts.length);
        append(selected);
        if (offset + selected.length < items.length) {
          position.resume = {
            id: task.id,
            offset: offset + selected.length,
            fingerprint: digest ?? createHash('sha256').update(JSON.stringify(task)).digest('hex'),
          };
          break;
        }
        delete position.resume;
        position.taskAfter = task.id;
        if (artifacts.length >= 512) break;
      }
      if (artifacts.length >= 512) break;
      if (page.nextCursor) {
        position.taskAfter = page.nextCursor;
        break;
      }
      position.phase = 'messages';
      delete position.taskAfter;
    }
    const remaining = 128 - scannedMessages;
    const page = await input.messages.getByThreadBeforeBounded(
      thread.id,
      position.before?.timestamp ?? state.startedAt + 1,
      remaining,
      position.before?.id,
      input.userId,
      remaining,
      { includeQueuedCatMessages: true, artifactProjection: true },
    );
    if (page.scannedCount > remaining || page.scannedCount < 0 || (!page.exhausted && !page.nextCursor))
      throw new WorksPageError('Invalid message page', 503);
    scannedMessages += page.scannedCount;
    const messages = [...page.messages].sort(
      (a, b) => getTimelineOrderTime(b) - getTimelineOrderTime(a) || b.id.localeCompare(a.id),
    );
    if (position.resume && messages[0]?.id !== position.resume.id)
      throw new WorksPageError('Work publication changed; reload catalogue', 409);
    let split = false;
    for (const message of messages) {
      const offset = position.resume?.offset ?? 0;
      const digest = position.resume ? fingerprint(message) : undefined;
      if (position.resume && digest !== position.resume.fingerprint)
        throw new WorksPageError('Work publication changed; reload catalogue', 409);
      const accepted = await input.accepted(thread.id, [message]);
      const room = 512 - artifacts.length;
      const acceptedSlice = accepted.slice(offset, offset + room);
      const projection = projectMessageArtifactSlice(
        message,
        Math.max(0, offset - accepted.length),
        room - acceptedSlice.length,
      );
      append([...acceptedSlice, ...projection.artifacts]);
      const consumed = offset + acceptedSlice.length + projection.artifacts.length;
      if (consumed < accepted.length + projection.total) {
        position.resume = { id: message.id, offset: consumed, fingerprint: digest ?? fingerprint(message) };
        split = true;
        break;
      }
      delete position.resume;
      position.before = { timestamp: getTimelineOrderTime(message), id: message.id };
      if (artifacts.length >= 512) {
        split = true;
        break;
      }
    }
    if (split) break;
    if (!page.exhausted) {
      if (page.nextCursor?.id === position.before?.id && page.scannedCount === 0)
        throw new WorksPageError('Message page made no progress', 503);
      position.before = page.nextCursor;
      break;
    }
    state.afterThread = thread.id;
    delete state.current;
    if (!threads.some((item) => item.id.localeCompare(thread.id) < 0)) {
      exhausted = true;
      break;
    }
  }
  return {
    artifacts,
    complete: exhausted,
    ...(!exhausted ? { nextCursor: Buffer.from(JSON.stringify(state)).toString('base64url') } : {}),
    cost: { scannedMessages, scannedTasks, visitedThreads, candidateCount: artifacts.length },
  };
}
