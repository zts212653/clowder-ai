'use client';
import type { WorkCoverView, WorkReference } from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import { readWorkCover, WORK_COVER_CHANGED_EVENT, WORK_PROJECTION_EVENT } from './work-cover-client';

// Chat, Home and Works may show the same fixed version at once: they share one read until a change notice.
const reads = new Map<string, Promise<WorkCoverView | null>>();
let generation = 0;

function read(key: string, reference: WorkReference) {
  let pending = reads.get(key);
  if (!pending) {
    pending = readWorkCover(reference).catch(() => {
      reads.delete(key);
      return null;
    });
    reads.set(key, pending);
  }
  return pending;
}

if (typeof window !== 'undefined') {
  const forget = () => {
    reads.clear();
    generation++;
  };
  window.addEventListener(WORK_COVER_CHANGED_EVENT, forget);
  window.addEventListener(WORK_PROJECTION_EVENT, forget);
}

/** The adopted cover of one exact work version; it follows saves from this page and server notices. */
export function useWorkCover(
  reference: Pick<WorkReference, 'contentRef' | 'ownerRevision'> | undefined,
  enabled: boolean,
) {
  const contentRef = reference?.contentRef;
  const ownerRevision = reference?.ownerRevision;
  const key = contentRef && ownerRevision ? JSON.stringify([contentRef, ownerRevision]) : '';
  const [state, setState] = useState<{ key: string; view: WorkCoverView | null; generation: number }>();
  const [seen, setSeen] = useState(generation);
  useEffect(() => {
    const refresh = () => setSeen(generation);
    window.addEventListener(WORK_COVER_CHANGED_EVENT, refresh);
    window.addEventListener(WORK_PROJECTION_EVENT, refresh);
    return () => {
      window.removeEventListener(WORK_COVER_CHANGED_EVENT, refresh);
      window.removeEventListener(WORK_PROJECTION_EVENT, refresh);
    };
  }, []);
  useEffect(() => {
    if (!key || !contentRef || !ownerRevision || !enabled) return;
    let live = true;
    void read(key, { contentRef, ownerRevision }).then((view) => {
      if (live) setState({ key, view, generation: seen });
    });
    return () => {
      live = false;
    };
  }, [key, contentRef, ownerRevision, enabled, seen]);
  const current = state?.key === key ? state : undefined;
  return { view: current?.view ?? null, loading: !!key && !current, stale: !!current && current.generation !== seen };
}
