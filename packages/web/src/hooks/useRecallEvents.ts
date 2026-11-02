import type { RecallResolverFamily } from '@cat-cafe/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { deduplicateRecallEvents, recallReplyInvocationId } from './recall-feed-model';
import { lookupRecallReply, type RecallReplyCursor, recallReplyMessage } from './recall-reply-lookup';
import { filterRecallEvents } from './recall-tool-events';
import type { MemoryCueStatus, RecallEvent, RecallResultItem, RecallSourceView } from './recall-types';

export {
  deduplicateRecallEvents,
  recallEventDisplayTitle,
  recallEventResultLabel,
} from './recall-feed-model';
export { parseTextResults } from './recall-result-parser';
export { filterRecallEvents } from './recall-tool-events';
export type { RecallEvent, RecallResultItem } from './recall-types';

type ReadStatus = 'loading' | 'ready' | 'error';
function cueViewKey(input: { invocationId?: string; cueId?: string; sourceRevision?: string; anchor?: string }) {
  return JSON.stringify([input.invocationId, input.cueId, input.sourceRevision, input.anchor]);
}
interface CueEntry {
  cueId: string;
  consumerCatId: string;
  sourceAnchor: string;
  sourceRevision: string;
  resolverFamily: RecallResolverFamily;
  status: MemoryCueStatus;
  presentedAt: number;
}
export function useThreadRecall(options: { threadId?: string; messages?: readonly ChatMessage[] } = {}) {
  const currentMessages = useChatStore((store) => store.messages);
  const currentThreadId = useChatStore((store) => store.currentThreadId);
  const messages = options.messages ?? currentMessages;
  const threadId = options.threadId ?? currentThreadId;
  const [generation, setGeneration] = useState(0);
  const [cueViewGeneration, setCueViewGeneration] = useState(0);
  const requestedCueViews = useRef({ threadId, keys: new Set<string>() });
  const cueCache = useRef(new Map<string, { token: string; events: RecallEvent[]; failed: boolean }>());
  const [history, setHistory] = useState<{
    threadId: string | null;
    events: RecallEvent[];
    status: ReadStatus;
    replies?: ChatMessage[];
    replyCursor?: RecallReplyCursor | null;
    cueInvocationIds?: string[];
    sourceViews?: RecallSourceView[];
    cueViewGeneration?: number;
  }>({
    threadId: null,
    events: [],
    status: 'loading',
  });
  const [deliveries, setDeliveries] = useState<{
    threadId: string | null;
    events: RecallEvent[];
    failed: boolean;
    loading: boolean;
  }>({ threadId: null, events: [], failed: false, loading: true });
  const live = useMemo(
    () =>
      messages.flatMap((message) => {
        if (message.extra?.crossPost || message.lifecycle?.kind === 'input') return [];
        const invocationId = recallReplyInvocationId(message);
        return filterRecallEvents(message.toolEvents ?? []).map((event) => ({
          ...event,
          catId: message.catId,
          invocationId,
          messageId: message.id,
          replyTimestamp: message.timestamp,
          sourceEventId:
            invocationId && message.catId && message.toolEvents?.find((tool) => tool.id === event.id)?.toolUseId
              ? `${invocationId}:${message.catId}:${message.toolEvents.find((tool) => tool.id === event.id)?.toolUseId}`
              : undefined,
        }));
      }),
    [messages],
  );
  const finished = messages
    .filter((message) => message.type === 'assistant' && !message.isStreaming)
    .map((message) => `${message.id}:${message.toolEvents?.length ?? 0}`)
    .join('|');
  const historyRequest = useMemo(
    () => ({ threadId, generation, finished, cueViewGeneration }),
    [threadId, generation, finished, cueViewGeneration],
  );
  useEffect(() => {
    const { threadId, cueViewGeneration } = historyRequest;
    let active = true;
    const controller = new AbortController();
    setHistory((previous) => ({
      threadId,
      events: previous.threadId === threadId ? previous.events : [],
      replies: previous.threadId === threadId ? previous.replies : [],
      replyCursor: previous.threadId === threadId ? previous.replyCursor : null,
      cueInvocationIds: previous.threadId === threadId ? previous.cueInvocationIds : [],
      sourceViews: previous.threadId === threadId ? previous.sourceViews : [],
      cueViewGeneration: previous.threadId === threadId ? previous.cueViewGeneration : 0,
      status: 'loading',
    }));
    if (!threadId) {
      setHistory({ threadId, events: [], status: 'ready' });
      return;
    }
    apiFetch(`/api/recall/events?threadId=${encodeURIComponent(threadId)}&limit=100`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('History unavailable');
        const body = (await response.json()) as {
          events?: RecallEvent[];
          sourceViews?: RecallSourceView[];
          cueInvocationIds?: string[];
          replyCursor?: RecallReplyCursor | null;
          replies?: Array<{
            messageId: string;
            catId: string;
            invocationId: string;
            parentInvocationId?: string;
            timestamp: number;
          }>;
        };
        const replies: ChatMessage[] = (body.replies ?? []).map(recallReplyMessage);
        if (!Array.isArray(body.events)) throw new Error('History response unavailable');
        if (active)
          setHistory({
            threadId,
            events: body.events,
            sourceViews: body.sourceViews ?? [],
            cueViewGeneration,
            status: 'ready',
            cueInvocationIds: body.cueInvocationIds ?? [],
            replies,
            replyCursor: body.replyCursor ?? null,
          });
      })
      .catch(() => {
        if (active) setHistory((previous) => ({ ...previous, threadId, status: 'error' }));
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [historyRequest]);
  const historyEvents = useMemo(() => (history.threadId === threadId ? history.events : []), [history, threadId]);
  const replyMessages =
    history.threadId === threadId
      ? [
          ...messages,
          ...(history.replies ?? []).filter((reply) => !messages.some((message) => message.id === reply.id)),
        ]
      : messages;
  const invocationKey = JSON.stringify(
    [
      ...new Set(
        [
          ...(history.threadId === threadId ? (history.cueInvocationIds ?? []) : []),
          ...messages.map(recallReplyInvocationId),
        ].filter((id): id is string => !!id),
      ),
    ]
      .sort()
      .map((id) => {
        const message = messages.find((message) => recallReplyInvocationId(message) === id);
        return {
          id,
          token: `${generation}:${message ? `${message.isStreaming}:${message.toolEvents?.length ?? 0}` : 'history'}`,
        };
      }),
  );
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setDeliveries((previous) => ({
      threadId,
      events: previous.threadId === threadId ? previous.events : [],
      failed: false,
      loading: true,
    }));
    const ids = JSON.parse(invocationKey) as Array<{ id: string; token: string }>;
    if (!threadId || !ids.length) {
      setDeliveries({ threadId, events: [], failed: false, loading: false });
      return;
    }
    // Bounded concurrency; one unavailable cue source never discards the sources that succeeded.
    (async () => {
      const events: RecallEvent[] = [];
      let failed = false;
      for (let offset = 0; offset < ids.length && active; offset += 4) {
        await Promise.all(
          ids.slice(offset, offset + 4).map(async ({ id: invocationId, token }) => {
            const cacheKey = `${threadId}:${invocationId}`;
            const cached = cueCache.current.get(cacheKey);
            if (cached?.token === token) {
              events.push(...cached.events);
              failed ||= cached.failed;
              return;
            }
            try {
              const response = await apiFetch(
                `/api/threads/${encodeURIComponent(threadId)}/invocations/${encodeURIComponent(invocationId)}/memory-cues`,
                { signal: controller.signal },
              );
              if (!response.ok) throw new Error('Cue source unavailable');
              const body = (await response.json()) as { cues?: CueEntry[] };
              if (!Array.isArray(body.cues)) throw new Error('Cue response unavailable');
              const cueEvents = body.cues.map((cue) => ({
                id: `cue:${invocationId}:${cue.cueId}`,
                catId: cue.consumerCatId === 'legacy-unbound' ? undefined : cue.consumerCatId,
                invocationId,
                cueId: cue.cueId,
                sourceRevision: cue.sourceRevision,
                query: '',
                resolverFamily: cue.resolverFamily,
                timestamp: cue.presentedAt,
                source: 'push' as const,
                cueStatus: cue.status,
                results: [{ title: '', anchor: cue.sourceAnchor, sourceType: cue.resolverFamily }],
              }));
              events.push(...cueEvents);
              if (active) cueCache.current.set(cacheKey, { token, events: cueEvents, failed: false });
            } catch {
              if (active) {
                failed = true;
                cueCache.current.set(cacheKey, { token, events: [], failed: true });
              }
            }
          }),
        );
      }
      if (active) setDeliveries({ threadId, events, failed, loading: false });
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [threadId, invocationKey]);
  useEffect(() => {
    if (requestedCueViews.current.threadId !== threadId) requestedCueViews.current = { threadId, keys: new Set() };
    if (history.threadId !== threadId || history.status !== 'ready' || deliveries.threadId !== threadId) return;
    const available = new Set((history.sourceViews ?? []).filter((view) => view.cueId).map(cueViewKey));
    const missing = deliveries.events.filter((event) => {
      const key = cueViewKey({ ...event, anchor: event.results?.[0]?.anchor });
      return !available.has(key) && !requestedCueViews.current.keys.has(key);
    });
    if (!missing.length) return;
    for (const event of missing)
      requestedCueViews.current.keys.add(cueViewKey({ ...event, anchor: event.results?.[0]?.anchor }));
    // One extra read per newly observed cue coordinate; omitted/failed views cannot form a refresh loop.
    setCueViewGeneration((value) => value + 1);
  }, [threadId, history, deliveries]);
  const events = useMemo(() => {
    const sourceViews = history.threadId === threadId ? (history.sourceViews ?? []) : [];
    const views = new Map(sourceViews.filter((view) => !view.cueId).map((view) => [view.anchor, view]));
    const cueViews = new Map(sourceViews.filter((view) => view.cueId).map((view) => [cueViewKey(view), view]));
    return [
      ...deduplicateRecallEvents(live, historyEvents),
      ...(deliveries.threadId === threadId ? deliveries.events : []),
    ].map((event) => ({
      ...event,
      results: event.results?.map((item): RecallResultItem => {
        const key = cueViewKey({ ...event, anchor: item.anchor });
        const view = event.cueId ? cueViews.get(key) : item.anchor ? views.get(item.anchor) : undefined;
        if (view)
          return {
            ...item,
            title: view.title ?? '',
            titleStatus: view.titleStatus,
            sourceType: view.kind ?? item.sourceType,
            href: view.href,
            sourceUnavailableReason: view.sourceUnavailableReason,
          };
        if (!event.cueId) return item;
        if (history.status === 'error') return { ...item, href: null, titleStatus: 'unavailable' };
        const pending =
          history.threadId !== threadId ||
          history.status === 'loading' ||
          (history.cueViewGeneration ?? 0) < cueViewGeneration ||
          requestedCueViews.current.threadId !== threadId ||
          !requestedCueViews.current.keys.has(key);
        return { ...item, href: null, titleStatus: pending ? 'loading' : 'unavailable' };
      }),
    }));
  }, [live, historyEvents, deliveries, history, threadId, cueViewGeneration]);
  const findReply = async (event: RecallEvent, signal: AbortSignal) => {
    if (!threadId) return undefined;
    return lookupRecallReply({
      threadId,
      event,
      messages: replyMessages,
      cursor: history.threadId === threadId ? (history.replyCursor ?? null) : null,
      signal,
      isCurrent: () => useChatStore.getState().currentThreadId === threadId,
      onPage: (replies, replyCursor) =>
        setHistory((previous) => (previous.threadId === threadId ? { ...previous, replies, replyCursor } : previous)),
    });
  };
  return {
    events,
    findReply,
    messages: replyMessages,
    threadId,
    historyStatus: history.threadId === threadId ? history.status : ('loading' as ReadStatus),
    historyCount: historyEvents.length,
    hasOlderReplies: history.threadId === threadId && !!history.replyCursor,
    retainedHistory:
      history.threadId === threadId && (history.events.length > 0 || (history.cueInvocationIds?.length ?? 0) > 0),
    cuesFailed: deliveries.threadId === threadId && deliveries.failed,
    cuesLoading: deliveries.threadId !== threadId || deliveries.loading,
    retry: () => setGeneration((value) => value + 1),
  };
}
export function useRecallEvents(): RecallEvent[] {
  return useThreadRecall().events;
}
