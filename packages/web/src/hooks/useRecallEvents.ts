import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ChatMessage } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { apiSessionIdentity } from '@/utils/api-session-identity';
import { deduplicateRecallEvents, recallReplyInvocationId } from './recall-feed-model';
import { lookupRecallReply, type RecallReplyCursor, recallReplyMessage } from './recall-reply-lookup';
import { readScopedRecallJson } from './recall-scoped-read';
import { filterRecallEvents } from './recall-tool-events';
import type { RecallEvent, RecallResultItem, RecallSourceView } from './recall-types';
import { useRecallCueDeliveries } from './useRecallCueDeliveries';
import { useRecallRefresh } from './useRecallRefresh';

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
export function useThreadRecall(options: { threadId?: string; messages?: readonly ChatMessage[] } = {}) {
  const currentMessages = useChatStore((store) => store.messages);
  const currentThreadId = useChatStore((store) => store.currentThreadId);
  const messages = options.messages ?? currentMessages;
  const threadId = options.threadId ?? currentThreadId;
  const session = useSyncExternalStore(
    apiSessionIdentity.subscribe,
    apiSessionIdentity.getSnapshot,
    apiSessionIdentity.getSnapshot,
  );
  const scope = JSON.stringify([threadId, session.generation]);
  const { generation, retry } = useRecallRefresh();
  const [cueViewGeneration, setCueViewGeneration] = useState(0);
  const requestedCueViews = useRef({ scope, keys: new Set<string>() });
  const [history, setHistory] = useState<{
    scope: string;
    threadId: string | null;
    events: RecallEvent[];
    status: ReadStatus;
    replies?: ChatMessage[];
    replyCursor?: RecallReplyCursor | null;
    cueInvocationIds?: string[];
    sourceViews?: RecallSourceView[];
    cueViewGeneration?: number;
  }>({
    scope: '',
    threadId: null,
    events: [],
    status: 'loading',
  });
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
    () => ({ threadId, scope, generation, finished, cueViewGeneration }),
    [threadId, scope, generation, finished, cueViewGeneration],
  );
  useEffect(() => {
    const { threadId, scope, cueViewGeneration } = historyRequest;
    let active = true;
    const controller = new AbortController();
    setHistory((previous) => ({
      threadId,
      scope,
      events: previous.scope === scope ? previous.events : [],
      replies: previous.scope === scope ? previous.replies : [],
      replyCursor: previous.scope === scope ? previous.replyCursor : null,
      cueInvocationIds: previous.scope === scope ? previous.cueInvocationIds : [],
      sourceViews: previous.scope === scope ? previous.sourceViews : [],
      cueViewGeneration: previous.scope === scope ? previous.cueViewGeneration : 0,
      status: 'loading',
    }));
    if (!threadId) {
      setHistory({ threadId, scope, events: [], status: 'ready' });
      return;
    }
    readScopedRecallJson(
      `/api/recall/events?threadId=${encodeURIComponent(threadId)}&limit=100`,
      JSON.stringify(historyRequest),
      controller.signal,
    )
      .then((response) => {
        const body = response as {
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
            scope,
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
        if (active)
          setHistory((previous) => ({
            ...(previous.scope === scope
              ? previous
              : { events: [], replies: [], cueInvocationIds: [], sourceViews: [] }),
            threadId,
            scope,
            status: 'error',
          }));
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [historyRequest]);
  const historyEvents = useMemo(() => (history.scope === scope ? history.events : []), [history, scope]);
  const replyMessages =
    history.scope === scope
      ? [
          ...messages,
          ...(history.replies ?? []).filter((reply) => !messages.some((message) => message.id === reply.id)),
        ]
      : messages;
  const deliveries = useRecallCueDeliveries({
    threadId,
    scope,
    generation,
    messages,
    historyInvocations: history.scope === scope ? (history.cueInvocationIds ?? []) : [],
  });
  useEffect(() => {
    if (requestedCueViews.current.scope !== scope) requestedCueViews.current = { scope, keys: new Set() };
    if (history.scope !== scope || history.status !== 'ready' || deliveries.scope !== scope) return;
    const available = new Set((history.sourceViews ?? []).filter((view) => view.cueId).map(cueViewKey));
    const missing = deliveries.events.filter((event) => {
      if (event.resolverFamily === 'matter') return false;
      const key = cueViewKey({ ...event, anchor: event.results?.[0]?.anchor });
      return !available.has(key) && !requestedCueViews.current.keys.has(key);
    });
    if (!missing.length) return;
    for (const event of missing)
      requestedCueViews.current.keys.add(cueViewKey({ ...event, anchor: event.results?.[0]?.anchor }));
    // One extra read per newly observed cue coordinate; omitted/failed views cannot form a refresh loop.
    setCueViewGeneration((value) => value + 1);
  }, [scope, history, deliveries]);
  const events = useMemo(() => {
    const sourceViews = history.scope === scope ? (history.sourceViews ?? []) : [];
    const views = new Map(sourceViews.filter((view) => !view.cueId).map((view) => [view.anchor, view]));
    const cueViews = new Map(sourceViews.filter((view) => view.cueId).map((view) => [cueViewKey(view), view]));
    return [
      ...deduplicateRecallEvents(live, historyEvents),
      ...(deliveries.scope === scope ? deliveries.events : []),
    ].map((event) => ({
      ...event,
      results: event.results?.map((item): RecallResultItem => {
        if (event.resolverFamily === 'matter') {
          const read = event.matterRead;
          return read?.status === 'current'
            ? { ...item, title: read.title, href: `/memory?matter=${encodeURIComponent(read.matterId)}` }
            : {
                ...item,
                title: '',
                titleStatus: 'unavailable',
                href: null,
                ...(read?.status === 'changed' ? { sourceUnavailableReason: 'source_corrected' } : {}),
              };
        }
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
          history.scope !== scope ||
          history.status === 'loading' ||
          (history.cueViewGeneration ?? 0) < cueViewGeneration ||
          requestedCueViews.current.scope !== scope ||
          !requestedCueViews.current.keys.has(key);
        return { ...item, href: null, titleStatus: pending ? 'loading' : 'unavailable' };
      }),
    }));
  }, [live, historyEvents, deliveries, history, scope, cueViewGeneration]);
  const findReply = async (event: RecallEvent, signal: AbortSignal) => {
    if (!threadId) return undefined;
    return lookupRecallReply({
      threadId,
      event,
      messages: replyMessages,
      cursor: history.scope === scope ? (history.replyCursor ?? null) : null,
      signal,
      isCurrent: () =>
        useChatStore.getState().currentThreadId === threadId &&
        apiSessionIdentity.getSnapshot().generation === session.generation,
      onPage: (replies, replyCursor) =>
        setHistory((previous) => (previous.scope === scope ? { ...previous, replies, replyCursor } : previous)),
    });
  };
  return {
    events,
    findReply,
    messages: replyMessages,
    threadId,
    historyStatus: history.scope === scope ? history.status : ('loading' as ReadStatus),
    historyCount: historyEvents.length,
    hasOlderReplies: history.scope === scope && !!history.replyCursor,
    retainedHistory:
      history.scope === scope && (history.events.length > 0 || (history.cueInvocationIds?.length ?? 0) > 0),
    cuesFailed: deliveries.scope === scope && deliveries.failed,
    cuesLoading: deliveries.scope !== scope || deliveries.loading,
    retry,
  };
}
export function useRecallEvents(): RecallEvent[] {
  return useThreadRecall().events;
}
