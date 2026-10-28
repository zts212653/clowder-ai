'use client';
import {
  type MessageSearchAnswerView,
  type MessageSearchResult,
  messageSearchAnswerRefSchema,
  messageSearchResponseSchema,
} from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { useShellPresentation } from '../shell/shell-presentation';
import { MessageDecisionSummary } from './MessageDecisionSummary';
import { MessageSearchResultRow } from './MessageSearchResultRow';
import { requestMessageFindOpen } from './message-find-events';

function rank(result: MessageSearchResult): number {
  return result.decisionSources?.some((fact) => fact.status === 'decided')
    ? 0
    : result.decisionSources?.some((fact) => fact.status === 'not-adopted')
      ? 1
      : 2;
}
async function readAnswer(
  messageId: string,
  blockId: string,
  signal?: AbortSignal,
): Promise<MessageSearchAnswerView | null> {
  const response = await apiFetch(`/api/evidence/answer?${new URLSearchParams({ messageId, blockId })}`, { signal });
  if (!response.ok) return null;
  const value: unknown = await response.json();
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const parsed = messageSearchResponseSchema.safeParse(record.response);
  if (
    record.status !== 'available' ||
    !parsed.success ||
    !messageSearchAnswerRefSchema.safeParse(record.publicationRef).success
  )
    return null;
  return {
    status: 'available',
    response: parsed.data,
    publicationRef: String(record.publicationRef),
    changedSources: typeof record.changedSources === 'number' ? record.changedSources : 0,
    decisionUpdated: record.decisionUpdated === true,
  };
}

/** No title, conclusion, source or verification bit is taken from rich meta. */
export function MessageSearchAnswerCard({ messageId, blockId }: { messageId?: string; blockId: string }) {
  const journey6 = useShellPresentation() === 'v2';
  const [view, setView] = useState<MessageSearchAnswerView | null>(null);
  const [reading, setReading] = useState(true),
    [notice, setNotice] = useState('');
  const threadId = useChatStore((state) => state.currentThreadId);
  const { getCatById } = useCatData();
  const coordinate = `${messageId ?? ''}:${blockId}`;
  const current = useRef(coordinate),
    generation = useRef(0);
  current.current = coordinate;
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const turn = ++generation.current;
      try {
        const next = messageId ? await readAnswer(messageId, blockId, signal) : null;
        if (signal?.aborted || turn !== generation.current || current.current !== coordinate) return null;
        setView(next);
        setReading(false);
        return next;
      } catch {
        if (!signal?.aborted && turn === generation.current && current.current === coordinate) {
          setView(null);
          setReading(false);
        }
        return null;
      }
    },
    [messageId, blockId, coordinate],
  );
  useEffect(() => {
    const controller = new AbortController();
    setView(null);
    setReading(true);
    if (journey6) void load(controller.signal);
    else setReading(false);
    return () => {
      controller.abort();
      generation.current++;
    };
  }, [journey6, load]);
  const beforeAction = async (result: MessageSearchResult, signal: AbortSignal) => {
    const fresh = await load(signal);
    const row = fresh?.response?.results.find(
      (row) => row.threadId === result.threadId && row.messageId === result.messageId,
    );
    return !!row && JSON.stringify(row) === JSON.stringify(result);
  };
  async function open(result?: MessageSearchResult) {
    const fresh = await load();
    if (!fresh?.response) return;
    const target =
      result &&
      fresh.response.results.find(
        (row) =>
          row.threadId === result.threadId &&
          row.messageId === result.messageId &&
          row.contentRevision === result.contentRevision,
      );
    if (result && !target) {
      setNotice('这条来源已更新，请查看当前结果后再打开。');
      return;
    }
    if (
      useChatStore.getState().currentThreadId !== threadId ||
      !requestMessageFindOpen(threadId, fresh.response, target)
    )
      setNotice('先回到这条对话的单栏阅读区，再打开查找。');
  }
  if (!journey6) return null;
  if (reading)
    return (
      <p role="status" className="p-3 text-xs text-cafe-muted">
        正在读取查找来源…
      </p>
    );
  if (!view?.response) return <p className="p-3 text-xs text-cafe-muted">来源卡暂不可用，请查看原消息或稍后重试。</p>;
  const response = view.response;
  const visible = response.results
    .map((result, index) => ({ result, index }))
    .sort((a, b) => rank(a.result) - rank(b.result) || a.index - b.index)
    .slice(0, 3);
  const resolveSpeaker = (id: string) => (id === 'user' ? 'co-creator' : getCatById(id)?.nickname || id);
  return (
    <section
      data-message-search-answer
      className="my-2 rounded-xl border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] text-cafe"
    >
      <p className="px-3 pt-3 text-xs text-cafe-muted">「{response.query}」的查找来源</p>
      <MessageDecisionSummary
        response={response}
        threadId={threadId}
        resolveSpeaker={resolveSpeaker}
        beforeAction={beforeAction}
      />
      {(!!view.changedSources || view.decisionUpdated) && (
        <p className="px-3 text-xs text-cafe-muted">有来源或已定事项已更新，旧正文与旧标签未沿用。</p>
      )}
      <ol className="divide-y divide-[var(--console-border-soft)] px-3">
        {visible.map(({ result, index }) => (
          <MessageSearchResultRow
            key={`${result.threadId}:${result.messageId}:${result.contentRevision}:${JSON.stringify(result.decisionSources)}`}
            result={result}
            response={response}
            index={index}
            currentThreadId={threadId}
            speaker={resolveSpeaker(result.speaker)}
            journey6
            readonly={false}
            onNavigate={(result) => void open(result)}
            resolveSpeaker={resolveSpeaker}
            beforeAction={(signal) => beforeAction(result, signal)}
          />
        ))}
      </ol>
      {!visible.length && <p className="p-3 text-sm text-cafe-muted">这次没有找到可确认的来源。</p>}
      <button
        type="button"
        className="m-3 text-xs text-[var(--accent-600)] hover:underline focus-visible:outline"
        onClick={() => void open()}
      >
        在查找里看全部 ›
      </button>
      {notice && (
        <p role="alert" className="px-3 pb-3 text-xs text-cafe-muted">
          {notice}
        </p>
      )}
    </section>
  );
}
