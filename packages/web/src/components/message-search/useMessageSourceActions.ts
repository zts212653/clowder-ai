import type { MessageSearchResult } from '@cat-cafe/shared';
import { useEffect, useRef, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { addQuoteToChat } from '../workspace/workspace-file-quote';
import { messageSourceQuote, type ReadSourceContext, readMessageSource } from './message-source-read';

/** A transient view of a freshly admitted source. The existing composer owns the only draft. */
export function useMessageSourceActions(
  result: MessageSearchResult,
  threadId: string,
  resolveSpeaker: (speaker: string) => string,
  beforeAction?: (signal: AbortSignal) => Promise<boolean>,
) {
  const [expanded, setExpanded] = useState(false);
  const [context, setContext] = useState<ReadSourceContext | null>(null);
  const [busy, setBusy] = useState<'expand' | 'quote' | null>(null);
  const [error, setError] = useState('');
  const [quoted, setQuoted] = useState(false);
  const operation = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      operation.current?.abort();
    },
    [],
  );
  function start(kind: 'expand' | 'quote') {
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    setBusy(kind);
    setError('');
    return controller;
  }
  async function expand() {
    if (expanded) {
      operation.current?.abort();
      setExpanded(false);
      setBusy(null);
      return;
    }
    setExpanded(true);
    setContext(null);
    const controller = start('expand');
    try {
      if (beforeAction && !(await beforeAction(controller.signal)))
        throw new Error('来源卡已更新，请查看当前结果后再操作。');
      const next = await readMessageSource(result, 3, controller.signal);
      if (!controller.signal.aborted) setContext(next);
    } catch (failure) {
      if (!controller.signal.aborted) {
        setContext(null);
        setError(failure instanceof Error ? failure.message : '来源暂不可读取。');
      }
    } finally {
      if (!controller.signal.aborted) setBusy(null);
    }
  }
  async function quote() {
    const controller = start('quote');
    try {
      if (beforeAction && !(await beforeAction(controller.signal)))
        throw new Error('来源卡已更新，请查看当前结果后再引用。');
      const fresh = await readMessageSource(result, 0, controller.signal);
      if (controller.signal.aborted) return;
      // A route change must not put the source into a different conversation's composer.
      const foreground = useChatStore.getState().currentThreadId;
      if (foreground !== threadId) throw new Error('当前对话已改变，请在新的对话重新引用。');
      const attachment = messageSourceQuote(result, fresh.message, resolveSpeaker);
      const admitted = addQuoteToChat(threadId, attachment);
      if (admitted.kind === 'added') setQuoted(true);
      else setError('未能放入当前输入框；原有草稿仍保留，请按输入框提示处理。');
    } catch (failure) {
      if (!controller.signal.aborted) {
        setContext(null);
        setError(failure instanceof Error ? failure.message : '引用暂不可用。');
      }
    } finally {
      if (!controller.signal.aborted) setBusy(null);
    }
  }
  return { expanded, context, busy, error, quoted, expand, quote };
}
