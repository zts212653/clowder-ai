'use client';
import type { VideoProjectScreening, WorkspaceContentAnnotation } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ModificationArtwork } from './ModificationArtwork';
import { type LoadedProjectModification, loadProjectModification } from './modification-loader';
import { ReviewPerson } from './screening-ui/ReviewPerson';
import { useScreeningCopy } from './screening-ui/screening.shell-copy';
import { screeningTime } from './screening-ui/screening-time';

type Props = {
  contentRef: string;
  annotation: WorkspaceContentAnnotation;
  screenings: VideoProjectScreening[];
  onJump: (screeningId: string, pts: number) => void;
  onClose: () => void;
};
export function ProjectModificationView({ contentRef, annotation, screenings, onJump, onClose }: Props) {
  const t = useScreeningCopy();
  const [data, setData] = useState<LoadedProjectModification | null>(null),
    [error, setError] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);
  const reload = useCallback(() => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setData(null);
    setError(null);
    void loadProjectModification(contentRef, annotation, screenings, controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) setData(value);
      },
      (failure: unknown) => {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '修改结果暂时无法核验。');
      },
    );
  }, [contentRef, annotation, screenings]);
  useEffect(() => {
    reload();
    return () => active.current?.abort();
  }, [reload]);
  return (
    <section aria-label={t.viewChange} className="space-y-3 rounded-xl border border-cafe-subtle bg-cafe-surface p-3">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-medium text-cafe-primary">{t.viewChange}</h2>
          <p className="mt-1 line-clamp-2 text-sm text-cafe-secondary" title={annotation.body}>
            {annotation.body}
          </p>
        </div>
        <button type="button" onClick={onClose} className="shrink-0 text-sm text-cafe-muted">
          {t.return}
        </button>
      </div>
      {error ? (
        <div role="alert" className="text-sm text-cafe-secondary">
          {error}
          <button type="button" className="ml-3 underline" onClick={reload}>
            {t.retry}
          </button>
        </div>
      ) : !data ? (
        <output className="text-sm text-cafe-muted">{t.readingChange}</output>
      ) : (
        <ModificationDetails contentRef={contentRef} data={data} onJump={onJump} onRetry={reload} />
      )}
    </section>
  );
}

function ModificationDetails({
  contentRef,
  data,
  onJump,
  onRetry,
}: {
  contentRef: string;
  data: LoadedProjectModification;
  onJump: (screeningId: string, pts: number) => void;
  onRetry: () => void;
}) {
  const t = useScreeningCopy();
  const [selected, setSelected] = useState(0),
    pair = data.pairs[selected];
  return (
    <>
      <div className="text-xs text-cafe-muted">
        <ReviewPerson actor={{ kind: data.actorKind, actorId: data.actor }} /> ·{' '}
        {data.notChanged ? t.statedUnchanged : t.modifiedInput(data.ownerRevision ?? 0)}
        {data.reason ? ` · ${data.reason}` : ''}
      </div>
      {data.notChanged ? (
        <p className="text-sm text-cafe-secondary">{data.notChanged}</p>
      ) : (
        <>
          {data.changes.length > 0 && (
            <ul className="space-y-1 text-sm text-cafe-secondary">
              {data.changes.map((change) => (
                <li key={change}>{change}</li>
              ))}
            </ul>
          )}
          {data.pairs.length > 1 && (
            <label className="block text-xs text-cafe-secondary">
              {t.artwork}
              <select
                aria-label={t.artwork}
                value={selected}
                onChange={(event) => setSelected(Number(event.target.value))}
                className="ml-3 rounded border border-cafe-subtle bg-cafe-surface p-1"
              >
                {data.pairs.map((item, index) => (
                  <option key={item.id} value={index}>
                    {item.label} · {t.originalInput(item.before.ownerRevision)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {pair ? (
            <ModificationArtwork key={pair.id} contentRef={contentRef} pair={pair} />
          ) : (
            <p className="text-sm text-cafe-secondary">{t.noPair}</p>
          )}
          <ModificationNavigation data={data} pairId={pair?.id} onJump={onJump} />
        </>
      )}
      <button type="button" onClick={onRetry} className="text-xs text-cafe-muted underline">
        {t.revalidate}
      </button>
    </>
  );
}

function ModificationNavigation({
  data,
  pairId,
  onJump,
}: {
  data: LoadedProjectModification;
  pairId?: string;
  onJump: (screeningId: string, pts: number) => void;
}) {
  const t = useScreeningCopy();
  const paired = data.filmsByPair.find((item) => item.pairId === pairId);
  const jump = pairId ? paired?.jump : data.jump;
  const seconds = pairId ? paired?.seconds : data.jumpSeconds;
  const unavailable = pairId ? (paired?.unavailable ?? true) : data.jumpUnavailable;
  const original = data.originalJumps.find((item) => item.pairId === pairId);
  if (jump && seconds !== undefined)
    return (
      <button
        type="button"
        className="rounded-lg bg-cafe-accent px-4 py-2 text-sm text-white"
        onClick={() => onJump(jump.screeningId, jump.pts)}
      >
        {t.newJump(screeningTime(seconds, true))}
      </button>
    );
  return (
    <div className="space-y-2">
      <p className="text-sm text-cafe-muted">{unavailable ? t.unavailableRender : t.noRender}</p>
      {original && (
        <button
          type="button"
          className="rounded-lg border border-cafe-subtle px-3 py-2 text-sm"
          onClick={() => onJump(original.screeningId, original.pts)}
        >
          {t.originalJump(screeningTime(original.seconds, true))}
        </button>
      )}
    </div>
  );
}
