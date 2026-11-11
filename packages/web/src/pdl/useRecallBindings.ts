'use client';
import { RECALL_DISPLAY_DOC_KINDS } from '@cat-cafe/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { MemoryRecallPageData } from '@/components/memory/page/recall-page-types';
import { recallResultHref } from '@/hooks/recall-display';
import { deduplicateRecallEvents, findRecallReply, recallReplyInvocationId } from '@/hooks/recall-feed-model';
import { recallReplyMessage } from '@/hooks/recall-reply-lookup';
import { filterRecallEvents } from '@/hooks/recall-tool-events';
import type { RecallEvent } from '@/hooks/recall-types';
import type { ChatMessage } from '@/stores/chat-types';
import type { ChatData } from './chat-models';
import { request } from './owner-api';

export function recallSourceRecords(events: RecallEvent[], replies: readonly ChatMessage[]) {
  return events.map((event) => {
    const reply = findRecallReply(event, replies);
    return {
      ...event,
      reply: reply ? { id: reply.id, timestamp: reply.timestamp } : undefined,
      results: event.results?.map((item) => ({
        ...item,
        sourceHref: recallResultHref(item),
        documentSource: RECALL_DISPLAY_DOC_KINDS.some((kind) => kind === item.sourceType),
      })),
    };
  });
}

export function useRecallBindings(
  data: ChatData,
  ui: { recallFor: string | null; recallExpected: number },
  needed: boolean | number = false,
) {
  const [attempt, retry] = useState(0);
  const [read, setRead] = useState<{ threadId: string; load: string; page: MemoryRecallPageData | null }>({
    threadId: '',
    load: 'loading',
    page: null,
  });
  const generation = useRef(0);
  const path = `/api/memory/recall?days=0&threadId=${encodeURIComponent(data.threadId)}&limit=100`;
  useEffect(() => {
    if (!needed) return;
    const abort = new AbortController(),
      threadId = data.threadId;
    generation.current++;
    setRead((current) => (current.threadId === threadId ? current : { threadId, load: 'loading', page: null }));
    void request<MemoryRecallPageData>(path, { signal: abort.signal }).then(
      (page) => {
        if (!abort.signal.aborted) setRead({ threadId, load: '', page });
      },
      () => {
        if (!abort.signal.aborted) setRead({ threadId, load: 'error', page: null });
      },
    );
    return () => {
      generation.current++;
      abort.abort();
    };
  }, [needed, path, attempt]);
  const page = read.threadId === data.threadId ? read.page : null;
  const more = async () => {
    if (!page?.nextCursor) return;
    const threadId = data.threadId,
      cursor = page.nextCursor,
      stamp = generation.current;
    setRead((read) => ({ ...read, load: 'loading' }));
    try {
      const next = await request<MemoryRecallPageData>(`${path}&cursor=${encodeURIComponent(cursor)}`);
      if (generation.current !== stamp) return;
      setRead({
        threadId,
        load: '',
        page: {
          ...next,
          records: [...page.records, ...next.records],
          replies: [...new Map([...page.replies, ...next.replies].map((reply) => [reply.messageId, reply])).values()],
        },
      });
    } catch {
      if (generation.current === stamp) setRead((read) => ({ ...read, load: 'error' }));
    }
  };
  const { events, replies } = useMemo(() => {
    const live: RecallEvent[] = data.messages.flatMap((message) => {
      if (message.extra?.crossPost || message.lifecycle?.kind === 'input') return [];
      return filterRecallEvents(message.toolEvents ?? []).map((event) => ({
        ...event,
        catId: message.catId,
        invocationId: recallReplyInvocationId(message),
        messageId: message.id,
        replyTimestamp: message.timestamp,
      }));
    });
    const replies = [
      ...data.messages,
      ...(page?.replies ?? [])
        .map(recallReplyMessage)
        .filter((reply) => !data.messages.some((message) => message.id === reply.id)),
    ];
    const events = deduplicateRecallEvents(live, page?.records.map((record) => record.event) ?? []);

    return { events, replies };
  }, [data.messages, page]);
  useEffect(() => {
    if (!ui.recallFor || !page?.nextCursor || read.load) return;
    const target = data.messages.find((message) => message.id === ui.recallFor);
    if (!target) return;
    const invocation = recallReplyInvocationId(target);
    const matching = events.filter(
      (event) =>
        event.messageId === target.id ||
        (invocation && event.invocationId === invocation && event.catId === target.catId),
    );
    const expected = ui.recallExpected;
    if (matching.length < expected) void more();
  }, [ui.recallFor, page, read.load]);
  const action = async (name: string, args: Record<string, string>) => {
    if (name === 'recallEventsMore' || name === 'recallOlder') {
      await more();
      return true;
    }
    if (name === 'refresh' && args.k === 'recall') {
      if (page && read.load === 'error') await more();
      else retry((n) => n + 1);
      return true;
    }
    if (name === 'recallBrowse') return true;
    return false;
  };
  const rawData = useMemo(
    () => ({
      threadId: read.threadId,
      load: read.load,
      page: page && { readStatus: page.readStatus, nextCursor: page.nextCursor },
      events: recallSourceRecords(events, replies),
    }),
    [read.threadId, read.load, page, events, replies],
  );
  return {
    action,
    data: rawData,
  };
}
