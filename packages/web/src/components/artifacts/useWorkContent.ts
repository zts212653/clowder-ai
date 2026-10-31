'use client';
import { MAX_HTML_WORK_VERSIONS, type WorkReference } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type Content, readWorkContent, readWorkMetadata, Unavailable } from './work-content-client';

export type WorkContentState =
  | { status: 'loading' }
  | { status: 'ready'; content: Content }
  | { status: 'error'; unavailable: boolean };

/** No stale body is rendered under a new thread/handle/version, even if an aborted response arrives late. */
export function useWorkContent(reference: WorkReference | null, threadId: string | null, sourceThreadId?: string) {
  const contentRef = reference?.contentRef;
  const ownerRevision = reference?.ownerRevision;
  const readThreadId = sourceThreadId ?? threadId;
  const key = JSON.stringify([threadId, readThreadId, contentRef, ownerRevision]);
  const refreshCurrent = useRef<() => void>(() => undefined);
  const refreshVersions = useCallback(() => refreshCurrent.current(), []);
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; value: WorkContentState }>();
  const reload = useCallback(() => {
    setLoaded(undefined);
    setAttempt((value) => value + 1);
  }, []);
  useEffect(() => {
    if (!contentRef || !ownerRevision || !threadId || !readThreadId) return;
    const abort = new AbortController();
    setLoaded({ key, value: { status: 'loading' } });
    let current: Content | undefined;
    let refreshSequence = 0;
    const fail = (error: unknown) => {
      if (!abort.signal.aborted)
        setLoaded({ key, value: { status: 'error', unavailable: error instanceof Unavailable } });
    };
    const refresh = async () => {
      if (current?.kind !== 'html') return;
      const sequence = ++refreshSequence;
      try {
        const info = await readWorkMetadata({ contentRef, ownerRevision }, readThreadId, abort.signal);
        if (abort.signal.aborted || sequence !== refreshSequence) return;
        if (info.description.mediaType !== 'text/html' || info.currentOwnerRevision > MAX_HTML_WORK_VERSIONS)
          throw new Error('Invalid HTML work head');
        current = { ...current, title: info.version.title, latest: info.currentOwnerRevision };
        setLoaded({ key, value: { status: 'ready', content: current } });
      } catch (error) {
        if (sequence === refreshSequence) fail(error);
      }
    };
    refreshCurrent.current = () => {
      void refresh();
    };
    const refreshListener = () => {
      void refresh();
    };
    const events = ['focus', 'cat-cafe:entrusted-work-projection-invalidated', 'cat-cafe:artifact-review-changed'];
    for (const event of events) window.addEventListener(event, refreshListener);
    void readWorkContent({ contentRef, ownerRevision }, readThreadId, abort.signal)
      .then((content) => {
        current = content;
        if (!abort.signal.aborted) setLoaded({ key, value: { status: 'ready', content } });
      })
      .catch(fail);
    return () => {
      abort.abort();
      refreshCurrent.current = () => undefined;
      for (const event of events) window.removeEventListener(event, refreshListener);
    };
  }, [key, contentRef, ownerRevision, threadId, readThreadId, attempt]);
  const state: WorkContentState =
    !threadId || !readThreadId
      ? { status: 'error', unavailable: true }
      : loaded?.key === key
        ? loaded.value
        : { status: 'loading' };
  return { state, reload, refreshVersions };
}
