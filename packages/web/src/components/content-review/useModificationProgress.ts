import type { ContentModificationDetailView, ContentModificationRequestView } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { checked, json, ModificationHttpError } from './modification-http';
import { isMovingModification } from './modification-polling';
import {
  describeModificationProgress,
  describeModificationReadFailure,
  type ModificationProgressCopy,
} from './modification-progress-copy';
import { olderModificationRead } from './modification-read-order';

const POLL_MS = 4000;
/** Focus and visibility changes are cheap hints, not reasons to re-read every historic request at once. */
const FOCUS_REFRESH_MS = 15_000;
const PROJECTION_EVENT = 'cat-cafe:entrusted-work-projection-invalidated';
/** The viewer is not allowed to see (or can no longer find) the request; say nothing rather than "error". */
const UNREADABLE = [401, 403, 404, 410];
const CANCEL_UNCONFIRMED = '取消结果尚未确认。请求和候选已保留；重试会核对同一次取消。';

type ReadState = 'idle' | 'ok' | 'failed' | 'hidden';

/**
 * Live, owner-read progress of one content-modification request for the line shown in chat. Reads and
 * cancels use the same routes and the same ordering/settle rules as the work-surface panel, so both
 * always describe the same request state. Only a request that can still change is polled.
 */
export function useModificationProgress(input: {
  requestId?: string;
  targetName: string;
  contentTitle?: string;
  placeCount?: number;
}) {
  const { requestId } = input;
  const [view, setView] = useState<ContentModificationDetailView | null>(null);
  const [readState, setReadState] = useState<ReadState>('idle');
  const [busy, setBusy] = useState(false);
  // Only "the last cancel's answer was lost" is state. Whether that still matters is decided from the request facts at
  // render time, so no ordering of a late transport failure and an authoritative read can bring it back.
  const [cancelAnswerLost, setCancelAnswerLost] = useState(false);
  const busyRef = useRef(false);
  const generation = useRef(0);
  const lastReadAt = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    if (!requestId) return;
    const ticket = generation.current;
    lastReadAt.current = Date.now();
    try {
      const response = await apiFetch(`/api/content-modifications/${encodeURIComponent(requestId)}`, undefined, {
        afterCurrentGet: true,
      });
      const next = await checked<ContentModificationDetailView>(response);
      if (ticket !== generation.current) return;
      setView((prior) => (olderModificationRead(prior, next) ? prior : next));
      setReadState('ok');
    } catch (error) {
      if (ticket !== generation.current) return;
      if (error instanceof ModificationHttpError && UNREADABLE.includes(error.status)) {
        setView(null);
        setReadState('hidden');
        return;
      }
      setReadState('failed');
    }
  }, [requestId]);

  useEffect(() => {
    generation.current += 1;
    lastReadAt.current = 0;
    setView(null);
    setReadState('idle');
    setCancelAnswerLost(false);
    if (!requestId) return;
    void refresh();
    // An explicit projection change is a real signal; focus and visibility are only hints and are throttled.
    const onProjectionChange = () => void refresh();
    const onHint = () => {
      if (Date.now() - lastReadAt.current >= FOCUS_REFRESH_MS) void refresh();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') onHint();
    };
    window.addEventListener(PROJECTION_EVENT, onProjectionChange);
    window.addEventListener('focus', onHint);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener(PROJECTION_EVENT, onProjectionChange);
      window.removeEventListener('focus', onHint);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [requestId, refresh]);

  const polling = view ? isMovingModification(view) : false;
  useEffect(() => {
    if (!requestId || !polling) return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [requestId, polling, refresh]);

  const cancel = useCallback(async (): Promise<void> => {
    if (!requestId || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setCancelAnswerLost(false);
    const ticket = generation.current;
    try {
      const next = await checked<ContentModificationRequestView>(
        await apiFetch(`/api/content-modifications/${encodeURIComponent(requestId)}/cancel`, json({})),
      );
      if (ticket === generation.current) setView((prior) => (prior ? { ...prior, ...next } : prior));
      await refresh();
      window.dispatchEvent(new Event(PROJECTION_EVENT));
    } catch {
      if (ticket === generation.current) setCancelAnswerLost(true);
    } finally {
      busyRef.current = false;
      if (ticket === generation.current) setBusy(false);
    }
  }, [requestId, refresh]);

  // The owner's cancellation receipt is authoritative: once any read or answer carries it, "not confirmed" is moot.
  const cancelError = cancelAnswerLost && !view?.record.control ? CANCEL_UNCONFIRMED : null;

  const copy: ModificationProgressCopy | null =
    !requestId || readState === 'hidden'
      ? null
      : readState === 'failed'
        ? describeModificationReadFailure()
        : view
          ? describeModificationProgress({
              view,
              targetName: input.targetName,
              contentTitle: input.contentTitle,
              placeCount: input.placeCount,
            })
          : null;

  return {
    copy,
    view,
    readState,
    busy,
    cancelError,
    cancel,
    reload: refresh,
    executionThreadId: view?.record.payload.threadId,
  };
}
