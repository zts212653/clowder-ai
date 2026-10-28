import { chatReferenceGroupSchema, type MessageSearchResponse, type MessageSearchResult } from '@cat-cafe/shared';
import { useEffect, useRef, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { matchingDecisionSources } from './message-query-presentation';
import { useMessageSourceActions } from './useMessageSourceActions';

type Decision = NonNullable<MessageSearchResult['decisionSources']>[number];
function DecisionEntry({
  fact,
  threadId,
  result,
  resolveSpeaker,
  beforeAction,
}: {
  fact: Decision;
  threadId: string;
  result: MessageSearchResult;
  resolveSpeaker: (speaker: string) => string;
  beforeAction?: (result: MessageSearchResult, signal: AbortSignal) => Promise<boolean>;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const source = useMessageSourceActions(
    result,
    threadId,
    resolveSpeaker,
    beforeAction ? (signal) => beforeAction(result, signal) : undefined,
  );
  useEffect(() => () => pending.current?.abort(), []);
  async function open() {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    try {
      if (beforeAction && !(await beforeAction(result, controller.signal)))
        throw new Error('已定事项已更新，请查看当前结果后再操作。');
      // Reuse the existing project/file resolver and Workbench. No new document browser.
      const reference = `${fact.documentPath}:${fact.line}`;
      const response = await apiFetch('/api/workspace/chat-references', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ groups: [{ threadId: result.threadId, references: [reference] }] }),
      });
      const body = (await response.json()) as { groups?: unknown[] };
      controller.signal.throwIfAborted();
      const group = chatReferenceGroupSchema.safeParse(body.groups?.[0]);
      const target =
        group.success && group.data.threadId === result.threadId
          ? group.data.results.find((item) => item.reference === reference)?.target
          : null;
      if (!response.ok || target?.kind !== 'file' || target.entryType === 'directory')
        throw new Error('已定表暂不可打开。');
      if (
        !useChatStore.getState().openWorkspacePath(threadId, {
          kind: 'file',
          path: target.path,
          line: fact.line,
          worktreeId: target.worktreeId,
        })
      )
        throw new Error('当前对话已改变，请重新打开。');
    } catch (failure) {
      if (controller.signal.aborted) return;
      setError(failure instanceof Error ? failure.message : '已定表暂不可打开。');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium leading-6 text-cafe-black">{fact.conclusion}</p>
      <p className="text-xs text-cafe-secondary">
        {[fact.decidedBy, fact.decidedAt, `${fact.featureId} · 已定事项`].filter(Boolean).join(' · ')}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void open()}
          disabled={busy || source.busy !== null}
          title={`${fact.documentPath}:${fact.line} · ${fact.documentRevision.slice(0, 10)}`}
          className="rounded text-xs text-[var(--accent-600)] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-500)] disabled:opacity-50"
        >
          {busy ? '打开中…' : '看已定事项 ›'}
        </button>
        <button
          type="button"
          disabled={busy || source.busy !== null || source.quoted}
          onClick={() => void source.quote()}
          className="rounded text-xs text-[var(--accent-600)] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-500)] disabled:opacity-50"
        >
          {source.busy === 'quote' ? '读取中…' : source.quoted ? '已引用' : '引用到聊天'}
        </button>
      </div>
      {(error || source.error) && (
        <p role="alert" className="text-xs text-cafe-secondary">
          {error || source.error}
        </p>
      )}
    </div>
  );
}

export function MessageDecisionSummary({
  response,
  threadId,
  resolveSpeaker,
  beforeAction,
}: {
  response: MessageSearchResponse;
  threadId: string;
  resolveSpeaker: (speaker: string) => string;
  beforeAction?: (result: MessageSearchResult, signal: AbortSignal) => Promise<boolean>;
}) {
  const facts = new Map<string, { fact: Decision; result: MessageSearchResult }>();
  for (const result of response.results)
    for (const fact of matchingDecisionSources(result, response.query)) {
      const key = `${fact.documentPath}:${fact.line}`;
      // Prefer a declared decision source over an unadopted proposal when both are already in the results.
      const previous = facts.get(key);
      if (!previous || fact.status === 'decided') facts.set(key, { fact, result });
    }
  if (!facts.size) return null;
  return (
    <section
      aria-label="定下来的"
      className="m-3 space-y-3 rounded-xl border border-[var(--console-border-soft)] bg-[var(--console-hover-bg)] p-3"
    >
      <p className="text-xs font-medium text-cafe-secondary">定下来的</p>
      {[...facts].map(([key, entry]) => (
        <DecisionEntry
          key={`${response.searchId}:${threadId}:${key}:${entry.result.threadId}:${entry.result.messageId}:${entry.result.contentRevision}`}
          fact={entry.fact}
          result={entry.result}
          threadId={threadId}
          resolveSpeaker={resolveSpeaker}
          beforeAction={beforeAction}
        />
      ))}
    </section>
  );
}
