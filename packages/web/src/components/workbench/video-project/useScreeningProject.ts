'use client';
import { useEffect, useRef, useState } from 'react';
import type { VideoProjectTarget } from '../video-project-surface';
import { loadProject, loadScreening, type ProjectSnapshot, type ScreeningDescriptor } from './api';

export function useScreeningProject(target: VideoProjectTarget, refresh: number) {
  const [state, setState] = useState<{
    head: ProjectSnapshot;
    input: ProjectSnapshot | null;
    descriptor: ScreeningDescriptor | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const retained = useRef(state);
  retained.current = state;
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh is the explicit owner revalidation key.
  useEffect(() => {
    const controller = new AbortController();
    const sameFilm =
      retained.current?.head.contentRef === target.contentRef &&
      retained.current?.descriptor?.screening.id === target.screeningId;
    if (!sameFilm) {
      setState(null);
      setLoading(true);
    }
    setError(null);
    void (async () => {
      const head = await loadProject(target.contentRef, controller.signal);
      const screeningId = target.screeningId ?? head.document.screenings?.at(-1)?.id;
      if (!screeningId || head.document.archivedAt) return { head, input: null, descriptor: null };
      const descriptor = await loadScreening(target.contentRef, screeningId, controller.signal);
      const input = await loadProject(target.contentRef, controller.signal, descriptor.screening.input.ownerRevision);
      if (input.blobDigest !== descriptor.screening.input.blobDigest) throw new Error('成片对应输入已变化。');
      return { head, input, descriptor };
    })()
      .then(
        (next) => {
          if (!controller.signal.aborted) setState(next);
        },
        (failure: unknown) => {
          if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '无法打开成片。');
        },
      )
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [target.contentRef, target.screeningId, refresh]);
  return { state, error, loading };
}
