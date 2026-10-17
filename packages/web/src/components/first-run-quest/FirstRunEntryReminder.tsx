'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useGuideStore } from '@/stores/guideStore';
import { apiFetch } from '@/utils/api-client';

import {
  entryReceiptTransition,
  failEntryReceipt,
  FIRST_RUN_ENTRY_GUIDE_ID as GUIDE_ID,
  FIRST_RUN_ENTRY_RECEIPT_PATH as PATH,
  type PendingEntryReceipt,
  saveEntryReceipt,
} from './firstRunEntryReceipt';

/** Personal persistence stays in preferences; presentation and interaction stay in F155. */
export function FirstRunEntryReminder({ enabled, threadId }: { enabled: boolean; threadId: string }) {
  const flowId = useGuideStore((s) => s.session?.flow.id ?? null);
  const startFailure = useGuideStore((s) => s.startFailure);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState('');
  const started = useRef(false);
  const revision = useRef(0);
  const pending = useRef<PendingEntryReceipt | null>(null);
  const writing = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const report = useCallback((message: string) => {
    if (mounted.current) setError(message);
  }, []);
  const flush = useCallback(async () => {
    if (writing.current) return;
    writing.current = true;
    try {
      while (pending.current) {
        const write = pending.current;
        const status = await saveEntryReceipt(write.status);
        if (write.status === 'completed') useGuideStore.getState().markCompletionPersisted(write.sessionId);
        if (pending.current === write || status === 'completed') pending.current = null;
        report('');
      }
    } catch (cause) {
      failEntryReceipt(pending.current);
      report(cause instanceof Error ? cause.message : '入口提醒记录保存失败');
    } finally {
      writing.current = false;
    }
  }, [report]);
  useEffect(() => {
    if (!enabled) {
      started.current = false;
      return;
    }
    return useGuideStore.subscribe((state, previous) => {
      const write = entryReceiptTransition(state, previous, threadId);
      if (!write) return;
      revision.current += 1;
      if (pending.current?.status !== 'completed') pending.current = write;
      void flush();
    });
  }, [enabled, threadId, flush]);
  // A stale read must not re-offer a guide after a local completion or dismissal.
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the explicit failed-read retry.
  useEffect(() => {
    if (!enabled || flowId || started.current || pending.current) return;
    const controller = new AbortController();
    const requestedRevision = revision.current;
    void apiFetch(PATH, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw Error('入口提醒暂时无法读取；可以直接开始对话。');
        const receipt = (await response.json()) as { status: string };
        if (controller.signal.aborted || requestedRevision !== revision.current) return;
        if (!pending.current) setError('');
        const state = useGuideStore.getState();
        if (
          receipt.status !== 'pending' ||
          state.session ||
          state.pendingStart ||
          state.completedGuides.has(`${threadId}::${GUIDE_ID}`)
        )
          return;
        started.current = true;
        state.reduceServerEvent({ action: 'start', guideId: GUIDE_ID, threadId });
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted && requestedRevision === revision.current)
          setError(cause instanceof Error ? cause.message : '入口提醒读取失败');
      });
    return () => controller.abort();
  }, [enabled, flowId, threadId, attempt]);
  const failure =
    error || (startFailure?.guideId === GUIDE_ID && startFailure.threadId === threadId ? startFailure.message : '');
  if (!enabled || !failure || (flowId && flowId !== GUIDE_ID)) return null;
  return (
    <output className="block text-sm text-cafe-secondary">
      {failure}{' '}
      <button
        type="button"
        onClick={() => {
          if (pending.current) void flush();
          else {
            started.current = false;
            setAttempt((value) => value + 1);
          }
        }}
      >
        重试入口提醒
      </button>
    </output>
  );
}
