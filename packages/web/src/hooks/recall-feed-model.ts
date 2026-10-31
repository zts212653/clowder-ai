import type { ChatMessage } from '@/stores/chat-types';
import { recallResultTitle, recallTypeLabel } from './recall-display';
import type { RecallEvent } from './recall-types';

export type RecallKind = 'search' | 'graph' | 'delivery';
export interface RecallGroup {
  id: string;
  catId?: string;
  invocationId?: string;
  messageId?: string;
  timestamp?: number;
  events: RecallEvent[];
}
/** Incoming posts carry their producer's stream coordinates, not a local reply's. */
export function recallReplyInvocationId(message: ChatMessage): string | undefined {
  if (message.type !== 'assistant' || !message.catId || message.extra?.crossPost) return undefined;
  if (message.lifecycle) return message.lifecycle.kind === 'response' ? message.lifecycle.invocationId : undefined;
  return message.extra?.stream?.turnInvocationId ?? message.extra?.stream?.invocationId;
}
export function recallKind(event: RecallEvent): RecallKind {
  return event.source === 'push' || event.cueStatus
    ? 'delivery'
    : event.toolName === 'graph_resolve'
      ? 'graph'
      : 'search';
}
export function recallReadCount(event: RecallEvent): number {
  return event.consumedCount ?? event.results?.filter((item) => item.consumed === true).length ?? 0;
}
export function recallEventDisplayTitle(event: RecallEvent): string {
  if (event.cueStatus)
    return event.results?.[0]
      ? recallResultTitle(event.results[0])
      : `${recallTypeLabel(event.resolverFamily)} · 标题没有记录下来`;
  if (event.source === 'push') return '通用上下文递送';
  return (
    (event.query === '(unknown)' ? '' : event.query.trim()) ||
    (event.toolName === 'list_recent' ? '最近记忆' : '未记录查询词')
  );
}
export function recallEventResultLabel(event: RecallEvent): string {
  if (event.cueStatus) {
    return {
      presented_unreported: '已递送·未回报',
      drilled: '点开看过',
      applied: '采用',
      dismissed: '明确不用',
      invalidated: '递送已失效',
    }[event.cueStatus];
  }
  if (event.resultStatus === 'error') return '召回失败';
  if (event.resultCount === 0 || event.resultStatus === 'no_results') return '没有命中';
  if (event.resultCount == null) return '结果没有记录下来';
  const reads = recallReadCount(event);
  return `命中 ${event.resultCount} 条 · ${reads ? `之后读了 ${reads} 条` : '之后没看到读取'}`;
}
/** Identity or a unique scoped operation; wall clock is used ONLY for display/order. */
export function deduplicateRecallEvents(live: RecallEvent[], history: RecallEvent[]): RecallEvent[] {
  const signature = (event: RecallEvent) =>
    event.catId && event.invocationId
      ? JSON.stringify([event.catId, event.invocationId, event.toolName, event.query])
      : undefined;
  const used = new Set<RecallEvent>();
  const merged = live.map((event) => {
    const exact = history.find(
      (other) =>
        !used.has(other) &&
        (other.id === event.id || (event.sourceEventId && event.sourceEventId === other.sourceEventId)),
    );
    const key = signature(event);
    const matches = key
      ? history.filter(
          (other) =>
            !used.has(other) &&
            signature(other) === key &&
            !(other.sourceEventId && event.sourceEventId && other.sourceEventId !== event.sourceEventId),
        )
      : [];
    const unique =
      key && live.filter((other) => signature(other) === key).length === 1 && matches.length === 1
        ? matches[0]
        : undefined;
    const other = exact ?? unique;
    if (!other) return event;
    used.add(other);
    const liveAnchors = new Set(event.results?.map((item) => item.anchor).filter(Boolean));
    const results = event.results?.length
      ? [
          ...event.results.map((item) => {
            const persisted = item.anchor
              ? other.results?.find((candidate) => candidate.anchor === item.anchor)
              : undefined;
            return { ...persisted, ...item, consumed: item.consumed ?? persisted?.consumed };
          }),
          ...(other.results ?? []).filter((item) => item.anchor && !liveAnchors.has(item.anchor)),
        ]
      : other.results;
    return {
      ...other,
      ...event,
      source: event.source ?? other.source,
      inspected: event.inspected ?? other.inspected,
      outcome: event.outcome ?? other.outcome,
      pushSurface: event.pushSurface ?? other.pushSurface,
      consumedCount: event.consumedCount ?? other.consumedCount,
      resultCount: event.resultCount ?? other.resultCount,
      resultStatus: event.resultStatus ?? other.resultStatus,
      results,
    };
  });
  return [...merged, ...history.filter((event) => !used.has(event))].sort((a, b) => a.timestamp - b.timestamp);
}
export function findRecallReply(event: RecallEvent, messages: readonly ChatMessage[]): ChatMessage | undefined {
  const replies = messages.filter((message) => recallReplyInvocationId(message));
  if (event.messageId) return replies.find((message) => message.id === event.messageId);
  if (!event.catId || !event.invocationId) return undefined;
  const exact = replies.filter(
    (message) => message.catId === event.catId && recallReplyInvocationId(message) === event.invocationId,
  );
  if (exact.length === 1) return exact[0];
  return undefined;
}
export function groupRecallEvents(events: RecallEvent[], messages: readonly ChatMessage[]): RecallGroup[] {
  const groups = new Map<string, RecallGroup>();
  for (const event of events) {
    const reply = findRecallReply(event, messages);
    const invocationId = (reply && recallReplyInvocationId(reply)) ?? event.invocationId;
    const id = invocationId ? JSON.stringify([event.catId, invocationId]) : `message:${event.messageId ?? event.id}`;
    let group = groups.get(id);
    if (!group) {
      group = {
        id,
        catId: event.catId,
        invocationId,
        messageId: reply?.id ?? event.messageId,
        timestamp: reply?.timestamp ?? event.replyTimestamp,
        events: [],
      };
      groups.set(id, group);
    }
    group.events.push(event);
  }
  // Event completion time can order unmatched groups, but never supplies a reply time or author.
  return [...groups.values()].sort(
    (a, b) => (b.timestamp ?? b.events[0].timestamp) - (a.timestamp ?? a.events[0].timestamp),
  );
}
export function recallCounts(events: RecallEvent[]): string {
  const counts = countRecallEvents(events);
  return [
    counts.search && `检索 ${counts.search}`,
    counts.graph && `关系查询 ${counts.graph}`,
    counts.delivery && `递送 ${counts.delivery}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Canonical per-turn count shared by the memory panel and the reply's “召回 N” projection. */
export function countRecallEvents(events: RecallEvent[]): {
  search: number;
  graph: number;
  delivery: number;
  total: number;
} {
  const kinds = events.map(recallKind);
  const search = kinds.filter((kind) => kind === 'search').length;
  const graph = kinds.filter((kind) => kind === 'graph').length;
  const delivery = kinds.filter((kind) => kind === 'delivery').length;
  return { search, graph, delivery, total: search + graph + delivery };
}
