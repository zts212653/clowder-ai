import type Database from 'better-sqlite3';
import { MemoryCueEpisodeStore } from '../domains/memory/cue/MemoryCueEpisodeStore.js';
import { projectInvocationCues } from '../domains/memory/cue/project-invocation-cues.js';
import { type MemoryInvocationReaders, memoryInvocationAccess } from './memory-invocation-access.js';
import { projectRecallPageEvent, readRecallPageEvent, recallCandidates } from './memory-recall-events.js';
import {
  type RecallPageCursor,
  type RecallPageQuery,
  type RecallTimelineRow,
  recallTimeline,
  visibleRecallThreads,
} from './memory-recall-query.js';
import {
  type RecallCandidateView,
  type RecallSourceReaders,
  recallCandidateViewReader,
} from './recall-candidate-view.js';
import { recallCueViewReader } from './recall-cue-view.js';
import { nextRecallReplyCursor, projectRecallReplies, type RecallReplyMessageStore } from './recall-reply-index.js';

export interface RecallPageSourceReaders extends RecallSourceReaders, MemoryInvocationReaders {
  messageStore?: RecallReplyMessageStore;
}
interface ProjectionContext {
  db: Database.Database;
  owner: string;
  readers: RecallPageSourceReaders;
  readCandidate: ReturnType<typeof recallCandidateViewReader>;
  episodes: MemoryCueEpisodeStore;
  cues: Map<string, ReturnType<typeof projectInvocationCues>>;
}
async function readCueRow(row: RecallTimelineRow, context: ProjectionContext) {
  const { owner, readers, cues, episodes, readCandidate } = context;
  const key = JSON.stringify([row.thread_id, row.invocation_id]);
  let invocation = cues.get(key);
  if (!invocation) {
    const access = await memoryInvocationAccess(readers, owner, row.thread_id, row.invocation_id);
    if (access.status !== 200) return null;
    invocation = projectInvocationCues(episodes.listByInvocation(owner, row.thread_id, row.invocation_id));
    cues.set(key, invocation);
  }
  const cue = invocation.find((item) => item.cueId === row.cue_id);
  if (!cue) return null;
  const view = await recallCueViewReader(
    { ownerUserId: owner, threadId: row.thread_id },
    readCandidate,
    readers.cueSourceReader,
    readers.profileMemoryStore,
    readers,
  )({
    invocation_id: row.invocation_id,
    cue_id: cue.cueId,
    resolver_family: cue.resolverFamily,
    source_anchor: cue.sourceAnchor,
    source_revision: cue.sourceRevision,
    consumer_cat_id: cue.consumerCatId,
  });
  return {
    partial: !view.title || view.titleStatus === 'unavailable',
    event: {
      id: row.key,
      catId: cue.consumerCatId === 'legacy-unbound' ? undefined : cue.consumerCatId,
      invocationId: row.invocation_id,
      cueId: cue.cueId,
      sourceRevision: cue.sourceRevision,
      query: '',
      resolverFamily: cue.resolverFamily,
      timestamp: cue.presentedAt,
      source: 'push' as const,
      ...(cue.pushSurface ? { pushSurface: cue.pushSurface } : {}),
      cueStatus: cue.status,
      results: [
        {
          title: view.title ?? '',
          titleStatus: view.titleStatus,
          anchor: cue.sourceAnchor,
          sourceType: cue.resolverFamily,
          href: view.href,
          ...(view.profileMemoryId ? { profileMemoryId: view.profileMemoryId } : {}),
          sourceUnavailableReason: view.sourceUnavailableReason,
        },
      ],
    },
  };
}
async function readSearchRow(row: RecallTimelineRow, context: ProjectionContext) {
  if (!row.recall_id) return null;
  const event = readRecallPageEvent(context.db, row.recall_id);
  if (!event) return null;
  const views = new Map<string, RecallCandidateView>();
  const candidates = recallCandidates(event);
  let partial = false;
  for (let offset = 0; offset < candidates.length; offset += 4) {
    const batch = await Promise.all(
      candidates
        .slice(offset, offset + 4)
        .map(async ({ anchor }) => [anchor, await context.readCandidate(anchor)] as const),
    );
    for (const [anchor, view] of batch) {
      views.set(anchor, view);
      if (!view.title || view.titleStatus === 'unavailable') partial = true;
    }
  }
  return { partial, event: projectRecallPageEvent(event, views) };
}
async function readTimelineRow(row: RecallTimelineRow, context: ProjectionContext) {
  try {
    return row.cue_id ? await readCueRow(row, context) : await readSearchRow(row, context);
  } catch {
    return null;
  }
}
async function readPageReplies(owner: string, threadIds: string[], store?: RecallReplyMessageStore) {
  const replies = [];
  const replyCursors: Record<string, ReturnType<typeof nextRecallReplyCursor>> = {};
  let partial = false;
  for (const threadId of threadIds) {
    if (!store) {
      partial = true;
      continue;
    }
    try {
      const messages = await store.getByThread(threadId, 500, owner);
      replies.push(...projectRecallReplies(messages).map((reply) => ({ ...reply, threadId })));
      replyCursors[threadId] = nextRecallReplyCursor(messages);
    } catch {
      partial = true;
    }
  }
  return { replies, replyCursors, partial };
}
/** Owner-global read over existing ledgers; no consumption or source mutation happens here. */
export async function readMemoryRecallPage(
  db: Database.Database,
  owner: string,
  readers: RecallPageSourceReaders,
  query: RecallPageQuery,
  cursor: RecallPageCursor | null,
) {
  if (!readers.threadStore) throw new Error('Thread store unavailable');
  const threads = await visibleRecallThreads(owner, readers.threadStore);
  const to = cursor?.to ?? Date.now();
  const rows = recallTimeline(db, owner, [...threads.keys()], query, cursor, to);
  const page = rows.slice(0, query.limit);
  const context: ProjectionContext = {
    db,
    owner,
    readers,
    readCandidate: recallCandidateViewReader(db, owner, readers),
    episodes: new MemoryCueEpisodeStore(db),
    cues: new Map(),
  };
  const records = [];
  let partial = false;
  for (const row of page) {
    const projected = await readTimelineRow(row, context);
    if (!projected) {
      partial = true;
      continue;
    }
    partial ||= projected.partial;
    records.push({
      threadId: row.thread_id,
      threadTitle: threads.get(row.thread_id) ?? '未命名对话',
      event: projected.event,
    });
  }
  const replies = await readPageReplies(owner, [...new Set(page.map((row) => row.thread_id))], readers.messageStore);
  const last = page.at(-1);
  return {
    days: Number(query.days),
    from: to - Number(query.days) * 86400000,
    to,
    readStatus: partial || replies.partial ? 'partial' : 'ready',
    records,
    replies: replies.replies,
    replyCursors: replies.replyCursors,
    next: rows.length > query.limit && last ? { to, at: last.at, key: last.key } : null,
  };
}
