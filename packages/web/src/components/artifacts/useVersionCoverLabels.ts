'use client';
import type { WorkCoverView } from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import { useShellCopy } from '@/components/shell/shell-copy';
import { workCoverCopy } from './work-cover.shell-copy';
import { readWorkCover, WORK_COVER_CHANGED_EVENT, WORK_PROJECTION_EVENT } from './work-cover-client';

const MAX_VERSIONS = 20;

/** Where each recent version's cover comes from, for the version list; unreadable versions say nothing. */
export function useVersionCoverLabels(contentRef: string | undefined, latest: number) {
  const t = useShellCopy(workCoverCopy);
  const [views, setViews] = useState<Map<number, WorkCoverView>>(new Map());
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const refresh = () => setTick((value) => value + 1);
    window.addEventListener(WORK_COVER_CHANGED_EVENT, refresh);
    window.addEventListener(WORK_PROJECTION_EVENT, refresh);
    return () => {
      window.removeEventListener(WORK_COVER_CHANGED_EVENT, refresh);
      window.removeEventListener(WORK_PROJECTION_EVENT, refresh);
    };
  }, []);
  useEffect(() => {
    if (!contentRef || latest < 1) return;
    const abort = new AbortController();
    const first = Math.max(1, latest - MAX_VERSIONS + 1);
    const revisions = Array.from({ length: latest - first + 1 }, (_, index) => first + index);
    void Promise.all(
      revisions.map((ownerRevision) =>
        readWorkCover({ contentRef, ownerRevision }, abort.signal).then(
          (view) => [ownerRevision, view] as const,
          () => null,
        ),
      ),
    ).then((rows) => {
      if (!abort.signal.aborted) setViews(new Map(rows.filter((row) => row !== null)));
    });
    return () => abort.abort();
  }, [contentRef, latest, tick]);
  return (revision: number) => {
    const view = views.get(revision);
    if (!view) return '';
    if (view.state === 'unavailable') return t.versionCover.unavailable;
    if (view.basis?.kind === 'inherited') return t.versionCover.inherited(view.basis.fromOwnerRevision);
    if (view.state === 'image' && view.image)
      return t.versionCover.image(
        view.image.origin.kind === 'work-asset' ? view.image.name : t.sources[view.image.origin.kind],
      );
    return t.versionCover.frame;
  };
}
