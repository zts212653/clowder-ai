'use client';
import {
  MAX_HTML_WORK_VERSIONS,
  type WorkReference,
  workHtmlSourceSchema,
  workReferenceSchema,
} from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { apiFetch } from '@/utils/api-client';

const metadata = z.object({
  reference: workReferenceSchema,
  currentOwnerRevision: z.number().int().positive().safe(),
  description: z.object({ mediaType: z.string() }),
  version: z.object({ title: z.string().min(1).max(240) }),
});
const body = z.object({
  reference: workReferenceSchema,
  mediaType: z.literal('text/html'),
  html: workHtmlSourceSchema.shape.html,
});
type Content = { kind: 'media' } | { kind: 'html'; html: string; title: string; latest: number };
export type WorkContentState =
  | { status: 'loading' }
  | { status: 'ready'; content: Content }
  | { status: 'error'; unavailable: boolean };
class Unavailable extends Error {}

function exact(actual: WorkReference, expected: WorkReference) {
  if (actual.contentRef !== expected.contentRef || actual.ownerRevision !== expected.ownerRevision)
    throw new Error('Owner returned a different fixed version');
}
async function command(action: 'read' | 'read-body', reference: WorkReference, threadId: string, signal: AbortSignal) {
  const response = await apiFetch('/api/works/command', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ threadId, command: { action, reference } }),
    signal,
  });
  if ([401, 403, 404].includes(response.status)) throw new Unavailable();
  if (!response.ok) throw new Error('Owner version read failed');
  return response.json();
}

async function readMetadata(reference: WorkReference, threadId: string, signal: AbortSignal) {
  const info = metadata.parse(await command('read', reference, threadId, signal));
  exact(info.reference, reference);
  if (info.currentOwnerRevision < reference.ownerRevision) throw new Error('Invalid owner head');
  return info;
}
async function readContent(reference: WorkReference, threadId: string, signal: AbortSignal): Promise<Content> {
  const info = await readMetadata(reference, threadId, signal);
  if (info.description.mediaType === 'video/mp4') return { kind: 'media' };
  if (info.description.mediaType !== 'text/html' || info.currentOwnerRevision > MAX_HTML_WORK_VERSIONS)
    throw new Error('Unsupported work format');
  const fixed = body.parse(await command('read-body', reference, threadId, signal));
  exact(fixed.reference, reference);
  return { kind: 'html', html: fixed.html, title: info.version.title, latest: info.currentOwnerRevision };
}

/** No stale body is rendered under a new thread/handle/version, even if an aborted response arrives late. */
export function useWorkContent(reference: WorkReference | null, threadId: string | null) {
  const contentRef = reference?.contentRef;
  const ownerRevision = reference?.ownerRevision;
  const key = JSON.stringify([threadId, contentRef, ownerRevision]);
  const refreshCurrent = useRef<() => void>(() => undefined);
  const refreshVersions = useCallback(() => refreshCurrent.current(), []);
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; value: WorkContentState }>();
  const reload = useCallback(() => {
    setLoaded(undefined);
    setAttempt((value) => value + 1);
  }, []);
  useEffect(() => {
    if (!contentRef || !ownerRevision || !threadId) return;
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
        const info = await readMetadata({ contentRef, ownerRevision }, threadId, abort.signal);
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
    void readContent({ contentRef, ownerRevision }, threadId, abort.signal)
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
  }, [key, contentRef, ownerRevision, threadId, attempt]);
  const state: WorkContentState = !threadId
    ? { status: 'error', unavailable: true }
    : loaded?.key === key
      ? loaded.value
      : { status: 'loading' };
  return { state, reload, refreshVersions };
}
