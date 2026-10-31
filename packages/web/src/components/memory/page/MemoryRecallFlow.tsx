'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { groupRecallEvents, type RecallGroup } from '@/hooks/recall-feed-model';
import { lookupRecallReply, recallReplyMessage } from '@/hooks/recall-reply-lookup';
import { handleTeleportEvent } from '@/hooks/useTeleport';
import { scrollToMessage } from '@/utils/scrollToMessage';
import { RecallReplyGroup } from '../RecallReplyGroup';
import { MemoryReadState } from './MemoryReadState';
import { memoryTime } from './memory-time';
import type { MemoryRecallPageData } from './recall-page-types';
import type { useMemoryRecall } from './use-memory-recall';

async function locateGroupReply(
  data: MemoryRecallPageData | null,
  threadId: string,
  group: RecallGroup,
  current: AbortController,
  isCurrent: () => boolean,
) {
  if (group.messageId) return group.messageId;
  return lookupRecallReply({
    threadId,
    event: group.events[0],
    messages: (data?.replies ?? []).filter((reply) => reply.threadId === threadId).map(recallReplyMessage),
    cursor: data?.replyCursors?.[threadId] ?? null,
    signal: current.signal,
    isCurrent,
    onPage: () => {},
  });
}
export function MemoryRecallFlow({ feed }: { feed: ReturnType<typeof useMemoryRecall> }) {
  const router = useRouter();
  const [locating, setLocating] = useState<string | null>(null);
  const [locateError, setLocateError] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const lookupBusy = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: generation invalidates all previous lookup work
  useEffect(() => {
    const current = new AbortController();
    controller.current = current;
    lookupBusy.current = false;
    setLocating(null);
    setLocateError(false);
    return () => current.abort();
  }, [feed.generation]);
  const records = feed.data?.records ?? [];
  const threads = new Map(records.map((row) => [row.threadId, row.threadTitle]));
  const groups = [...threads]
    .flatMap(([threadId, title]) =>
      groupRecallEvents(
        records.filter((row) => row.threadId === threadId).map((row) => row.event),
        (feed.data?.replies ?? []).filter((reply) => reply.threadId === threadId).map(recallReplyMessage),
      ).map((group) => ({ threadId, title, group, key: JSON.stringify([threadId, group.id]) })),
    )
    .sort(
      (a, b) => (b.group.timestamp ?? b.group.events[0].timestamp) - (a.group.timestamp ?? a.group.events[0].timestamp),
    );
  const locate = async (threadId: string, key: string, group: RecallGroup) => {
    const current = controller.current;
    if (!current || lookupBusy.current) return;
    lookupBusy.current = true;
    const isCurrent = () => controller.current === current && !current.signal.aborted;
    setLocateError(false);
    setLocating(key);
    try {
      const messageId = await locateGroupReply(feed.data, threadId, group, current, isCurrent);
      if (!isCurrent()) return;
      if (!messageId) {
        setLocateError(true);
        return;
      }
      handleTeleportEvent({ threadId, messageId }, null, {
        pushThreadRoute: (id) => router.push(`/thread/${encodeURIComponent(id)}`),
        scrollToMessage,
      });
    } catch {
      if (isCurrent()) setLocateError(true);
    } finally {
      if (controller.current === current) {
        lookupBusy.current = false;
        setLocating(null);
      }
    }
  };
  return (
    <section className="min-w-0" aria-label="所有对话的召回流水">
      <MemoryReadState
        loading={feed.loading}
        error={feed.error}
        empty={records.length === 0 && feed.data?.readStatus === 'ready'}
        noun="召回记录"
        retry={feed.retry}
      />
      {feed.data?.readStatus === 'partial' && (
        <output className="my-3 block text-compact text-cafe-muted">
          部分读到：有些记录或回复的对应关系暂时读不到。
          <button type="button" onClick={feed.retry} className="ml-2 text-cafe-accent underline">
            重读
          </button>
        </output>
      )}
      {locateError && (
        <p role="alert" className="my-3 text-compact">
          暂时定位不到对应回复，可以先打开来源对话查看。
        </p>
      )}
      {groups.map(({ threadId, title, group, key }, index) => (
        <article
          key={key}
          className="mb-3 min-w-0 rounded-xl border border-cafe-subtle bg-[var(--console-card-bg)] p-3"
        >
          <Link
            href={`/thread/${encodeURIComponent(threadId)}`}
            className="mb-2 block break-words text-compact text-cafe-accent hover:underline"
          >
            {title} ↗
          </Link>
          <RecallReplyGroup
            group={group}
            allowDeliveryExpansion={false}
            replyTimeLabel={group.timestamp == null ? undefined : `${memoryTime(group.timestamp)} 的回复`}
            initiallyExpanded={index === 0}
            locating={locating === key}
            earlierRepliesPending={Boolean(feed.data?.replyCursors?.[threadId])}
            onLocate={(row) => void locate(threadId, key, row)}
          />
        </article>
      ))}
      {feed.moreError && (
        <p role="alert" className="my-3 text-compact">
          暂时读不到更早的记录，已读到的记录仍在这里。
        </p>
      )}
      {feed.data?.nextCursor && (
        <button
          type="button"
          disabled={feed.moreLoading}
          onClick={() => void feed.loadMore()}
          className="my-3 rounded-lg border border-cafe-subtle px-4 py-2 text-compact disabled:text-cafe-muted"
        >
          {feed.moreLoading ? '正在读取…' : feed.moreError ? '重试更早的记录' : '读取更早的记录'}
        </button>
      )}
    </section>
  );
}
