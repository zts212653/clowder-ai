'use client';
import type { InvocationTrajectorySummary } from '@cat-cafe/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ExternalRuntimeSessionListItem } from '@/components/runtime-sessions/external-runtime-session-types';
import type { SessionSummary } from '@/components/session-chain-types';
import type { InvocationDetailResponse } from '@/components/workspace/trajectory/invocation-trajectory-model';
import {
  buildInvocationTimelineRows,
  type InvocationTimelineRow,
} from '@/components/workspace/trajectory/invocation-trajectory-model';
import { useChatStore } from '@/stores/chatStore';
import type { ChatData } from './chat-models';
import { request, write } from './owner-api';

interface TranscriptHit {
  sessionId: string;
  kind: 'event';
  snippet: string;
  pointer: { eventNo: number; invocationId?: string };
}
interface ExternalMessage {
  content?: string;
  eventNo: number;
  oversized?: boolean;
}
interface EventSlice {
  eventNo: number;
  charOffset: number;
  eventSlice: string;
  nextCharOffset?: number;
}
export function useExecutionBindings(
  data: ChatData,
  state: { tjMode: string; execQ?: string },
  needed: boolean | number = false,
) {
  const invocations = useChatStore((s) =>
    s.currentThreadId === data.threadId ? s.catInvocations : s.threadStates[data.threadId]?.catInvocations,
  );
  const [external, setExternal] = useState<{
    threadId: string;
    load: string;
    sessions: ExternalRuntimeSessionListItem[];
  }>({
    threadId: '',
    load: 'loading',
    sessions: [],
  });
  const [externalDetail, setExternalDetail] = useState<{
    id: string;
    cursor: number;
    messages: ExternalMessage[];
    nextCursor?: { eventNo: number };
  } | null>(null);
  const [read, setRead] = useState<{
    threadId: string;
    load: string;
    sessions: SessionSummary[];
    runs: InvocationTrajectorySummary[];
  }>({ threadId: '', load: 'loading', sessions: [], runs: [] });
  const [detail, setDetail] = useState<(InvocationDetailResponse & { timelineRows: InvocationTimelineRow[] }) | null>(
    null,
  );
  const [generation, setGeneration] = useState(0);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState({ threadId: '', query: '', load: '', hits: [] as TranscriptHit[] });
  const detailRequest = useRef(0);
  const refresh = () => setGeneration((v) => v + 1);
  useEffect(() => {
    if (!needed) return; // Full trajectory and session state on appearance.
    const abort = new AbortController(),
      threadId = data.threadId;
    const load = async () => {
      try {
        const [sessions, runs] = await Promise.all([
          request<{ sessions: SessionSummary[] }>(`/api/threads/${encodeURIComponent(threadId)}/sessions`, {
            signal: abort.signal,
          }),
          request<{ invocations: InvocationTrajectorySummary[] }>(
            `/api/threads/${encodeURIComponent(threadId)}/invocations?limit=500`,
            { signal: abort.signal },
          ),
        ]);
        if (!abort.signal.aborted) setRead({ threadId, load: '', sessions: sessions.sessions, runs: runs.invocations });
      } catch {
        if (!abort.signal.aborted) setRead({ threadId, load: 'error', sessions: [], runs: [] });
      }
    };
    const loadExternal = async () => {
      try {
        const result = await request<{ sessions: ExternalRuntimeSessionListItem[] }>(
          '/api/external-runtime-sessions?runtime=antigravity-desktop&limit=20',
          { signal: abort.signal },
        );
        if (!abort.signal.aborted)
          setExternal({
            threadId,
            load: '',
            sessions: result.sessions.filter(
              (x) =>
                x.threadId === threadId ||
                (x.binding.mode === 'thread' ? x.binding.threadId : x.binding.anchorThreadId) === threadId,
            ),
          });
      } catch {
        if (!abort.signal.aborted) setExternal({ threadId, load: 'error', sessions: [] });
      }
    };
    setRead((current) =>
      current.threadId === threadId ? current : { threadId, load: 'loading', sessions: [], runs: [] },
    );
    const poll = () => {
      if (document.hidden) return;
      void load();
      void loadExternal();
    };
    poll();
    return () => {
      abort.abort();
      detailRequest.current++;
    };
  }, [needed, data.threadId, generation]);
  useEffect(() => {
    if (!needed || !query.trim()) return;
    const abort = new AbortController(),
      threadId = data.threadId,
      q = query.trim();
    setSearch({ threadId, query: q, load: 'loading', hits: [] });
    void request<{ hits: TranscriptHit[] }>(
      `/api/threads/${encodeURIComponent(threadId)}/sessions/search?${new URLSearchParams({ q, scope: 'transcripts', limit: '200' })}`,
      { signal: abort.signal },
    )
      .then(({ hits }) => {
        if (!abort.signal.aborted) setSearch({ threadId, query: q, load: '', hits });
      })
      .catch(() => {
        if (!abort.signal.aborted) setSearch({ threadId, query: q, load: 'error', hits: [] });
      });
    return () => abort.abort();
  }, [needed, data.threadId, query, generation]);
  const readExternal = async (id: string, more: boolean, cursor = 0) => {
    if (
      !(external.threadId === data.threadId && external.sessions.some((x) => x.sessionId === id)) &&
      !(read.threadId === data.threadId && read.sessions.some((session) => session.id === id))
    )
      throw new Error('会话已变化，请重新读取');
    const ticket = ++detailRequest.current,
      before = more && externalDetail?.id === id ? externalDetail : null;
    const next = await request<{
      messages: ExternalMessage[];
      nextCursor?: { eventNo: number };
    }>(
      `/api/sessions/${encodeURIComponent(id)}/events?${new URLSearchParams({ view: 'chat', cursor: String(before?.nextCursor?.eventNo ?? cursor), limit: '50' })}`,
    );
    const messages = await Promise.all(
      next.messages.map(async (message) => {
        if (!message.oversized) return message;
        let offset: number | undefined = 0,
          serialized = '';
        do {
          const slice: EventSlice = await request<EventSlice>(
            `/api/sessions/${encodeURIComponent(id)}/events?${new URLSearchParams({ view: 'raw', cursor: String(message.eventNo), limit: '1', charOffset: String(offset) })}`,
          );
          if (slice.eventNo !== message.eventNo || slice.charOffset !== offset) throw new Error('外部记录来源不一致');
          serialized += slice.eventSlice;
          offset = slice.nextCharOffset;
        } while (offset !== undefined);
        const event = JSON.parse(serialized) as { content: string | { type: string; text?: string }[] };
        return {
          ...message,
          content:
            typeof event.content === 'string'
              ? event.content
              : event.content
                  .filter((part) => part.type === 'text')
                  .map((part) => part.text)
                  .join('\n'),
        };
      }),
    );
    if (ticket !== detailRequest.current) return;
    setDetail(null);
    setExternalDetail({
      id,
      cursor: before?.cursor ?? cursor,
      messages: [...(before?.messages ?? []), ...messages],
      nextCursor: next.nextCursor,
    });
  };
  const action = async (name: string, args: Record<string, string>) => {
    if (name === 'execSearch') {
      state.execQ = args.q;
      setQuery(args.q);
      return true;
    }
    if (name === 'refresh' && args.k === 'exec') {
      if (externalDetail) await readExternal(externalDetail.id, false, externalDetail.cursor);
      else if (detail) await action('execOpen', { v: detail.invocationId });
      refresh();
      return true;
    }
    if (name === 'execOpen') {
      setExternalDetail(null);
      const ticket = ++detailRequest.current;
      const live = data.executions.find(
        (execution) => execution.turnInvocationId === args.v && execution.kind !== 'managed_command',
      );
      const opened = detail?.invocationId === args.v ? detail.summary : undefined;
      const threadId = live?.threadId ?? opened?.threadId ?? data.threadId;
      let run = opened ?? (read.threadId === threadId ? read.runs.find((r) => r.invocationId === args.v) : undefined);
      const session = args.sessionId ? read.sessions.find((s) => s.id === args.sessionId) : undefined;
      if (!run && !session) {
        const owner = await request<{ invocations: InvocationTrajectorySummary[] }>(
          `/api/threads/${encodeURIComponent(threadId)}/invocations?limit=500`,
        );
        run = owner.invocations.find((r) => r.invocationId === args.v);
      }
      if (ticket !== detailRequest.current) return true;
      if ((!run && !session) || (run && (run.threadId !== threadId || (live && run.catId !== live.catId))))
        throw new Error('运行来源不一致');
      const sessionId = run?.sessionId ?? session!.id,
        catId = run?.catId ?? session!.catId;
      const next = await request<InvocationDetailResponse>(
        `/api/sessions/${encodeURIComponent(sessionId)}/invocations/${encodeURIComponent(args.v)}`,
      );
      if (ticket !== detailRequest.current) return true;
      if (
        next.invocationId !== args.v ||
        next.summary?.threadId !== threadId ||
        next.summary.invocationId !== args.v ||
        next.summary.catId !== catId ||
        next.summary.sessionId !== sessionId ||
        next.events.some(
          (event) => event.sessionId !== sessionId || event.threadId !== threadId || event.catId !== catId,
        )
      )
        throw new Error('运行来源不一致');
      setDetail({ ...next, timelineRows: buildInvocationTimelineRows(next.events, Number.MAX_SAFE_INTEGER).allRows });
      return true;
    }
    if (name === 'externalSessionOpen' || name === 'runtimeExternalMore') {
      await readExternal(args.sessionId, name === 'runtimeExternalMore', Number(args.eventNo ?? 0));
      return true;
    }
    if (name === 'sessionSeal' || name === 'sessionRestore' || name === 'stCompress') {
      const sessions = read.sessions.filter((s) => s.catId === args.k),
        current = sessions.find((s) => s.status === 'active');
      if (name === 'sessionSeal') {
        if (!current) throw new Error('当前会话已变化');
        await write(`/api/sessions/${encodeURIComponent(current.id)}/seal`, {});
      }
      if (name === 'sessionRestore') {
        const selected = read.sessions.find((s) => s.id === args.id);
        if (!selected) throw new Error('会话已变化');
        const active = read.sessions.find((s) => s.catId === selected.catId && s.status === 'active');
        await write(`/api/sessions/${encodeURIComponent(selected.id)}/unseal`, {
          expectedActiveSessionId: active?.id ?? null,
        });
      }
      if (name === 'stCompress')
        await write(
          `/api/threads/${encodeURIComponent(data.threadId)}/sessions/${encodeURIComponent(args.k)}/compact-native`,
          {},
        );
      refresh();
      return true;
    }
    return false;
  };
  const rawData = useMemo(
    () => ({ invocations, external, externalDetail, read, detail, search }),
    [invocations, external, externalDetail, read, detail, search],
  );
  return { action, data: rawData };
}
