'use client';
import type { VideoProjectReviewHistory, WorkspaceContentAnnotation, WorkspaceContentReview } from '@cat-cafe/shared';
import { useState } from 'react';
import { projectPath, projectRequest } from './api';
import { ReviewPerson } from './screening-ui/ReviewPerson';
import { useScreeningCopy } from './screening-ui/screening.shell-copy';

function isUnchanged(event: VideoProjectReviewHistory | undefined) {
  return event?.kind === 'addressed' && event.result && 'kind' in event.result && event.result.kind === 'not-changed';
}
function opinionStatus(annotation: WorkspaceContentAnnotation, t: ReturnType<typeof useScreeningCopy>) {
  const history = annotation.projectHistory?.slice().reverse() ?? [];
  const latest = history.find((event) => ['addressed', 'reopened', 'resolved'].includes(event.kind));
  const previousAnswer = history.find((event) => event.kind === 'addressed');
  const canCompare = Boolean(previousAnswer?.result && !isUnchanged(previousAnswer));
  const answered = latest?.kind === 'addressed',
    modified = answered && !isUnchanged(latest);
  const label = modified
    ? t.modified
    : isUnchanged(latest)
      ? t.unchanged
      : annotation.state === 'resolved'
        ? t.closed
        : t.open;
  return { answered, modified, canCompare, label };
}
function OpinionHistory({ history }: { history: VideoProjectReviewHistory[] }) {
  const t = useScreeningCopy();
  const labels = {
    located: t.located,
    replied: t.replied,
    addressed: t.modified,
    reopened: t.reopened,
    resolved: t.closed,
    created: t.created,
  };
  return (
    <ol className="mt-3 space-y-2 text-xs text-cafe-secondary">
      {history
        .filter((event) => event.kind !== 'created')
        .map((event) => (
          <li key={event.operationId}>
            <ReviewPerson actor={event.actor} /> · {isUnchanged(event) ? t.unchanged : labels[event.kind]}
            {event.reason ? ` · ${event.reason}` : ''}
            {event.result && 'kind' in event.result && event.result.kind === 'not-changed'
              ? ` · ${event.result.reason}`
              : ''}
          </li>
        ))}
    </ol>
  );
}
function OpinionActions({
  answered,
  modified,
  canCompare,
  busy,
  onCompare,
  onReopen,
}: {
  answered: boolean;
  modified: boolean;
  canCompare: boolean;
  busy: boolean;
  onCompare: () => void;
  onReopen: () => void;
}) {
  const t = useScreeningCopy();
  if (!answered && !canCompare) return null;
  return (
    <div className="mt-3 flex gap-3">
      {canCompare && (
        <button type="button" onClick={onCompare}>
          {modified ? t.viewChange : t.viewPrevious}
        </button>
      )}
      {answered && (
        <button type="button" disabled={busy} onClick={onReopen}>
          {t.reopened}
        </button>
      )}
    </div>
  );
}
export function ProjectReviewPanel({
  contentRef,
  review,
  screeningId,
  pending,
  error,
  onRefresh,
  onLocate,
  onCompare,
}: {
  contentRef: string;
  review: WorkspaceContentReview | null;
  screeningId: string;
  pending: boolean;
  error: string | null;
  onRefresh: () => void;
  onLocate: (annotation: WorkspaceContentAnnotation) => void;
  onCompare: (annotation: WorkspaceContentAnnotation) => void;
}) {
  const t = useScreeningCopy();
  const [failure, setFailure] = useState<string | null>(null),
    [busy, setBusy] = useState<string | null>(null);
  const [reopening, setReopening] = useState<string | null>(null),
    [reason, setReason] = useState('');
  const reopen = async (annotation: WorkspaceContentAnnotation) => {
    if (!review) return;
    setBusy(annotation.id);
    setFailure(null);
    const operationId = crypto.randomUUID();
    try {
      try {
        await projectRequest(`${projectPath(contentRef)}/review/actions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            expectedRevision: review.revision,
            operationId,
            action: { kind: 'reopened', annotationId: annotation.id, reason },
          }),
        });
      } catch (original) {
        const confirmed = await projectRequest(
          `${projectPath(contentRef)}/review/operations/${encodeURIComponent(operationId)}`,
        );
        if (!confirmed || typeof confirmed !== 'object' || !('receipt' in confirmed) || !confirmed.receipt)
          throw original;
      }
      setReopening(null);
      setReason('');
      onRefresh();
    } catch (problem) {
      setFailure(problem instanceof Error ? problem.message : '操作结果尚未确认，请刷新经过后重试。');
    } finally {
      setBusy(null);
    }
  };
  const annotations =
    review?.annotations.filter(
      (annotation) => !annotation.projectMessage || annotation.projectMessage.screeningId === screeningId,
    ) ?? [];
  return (
    <aside
      aria-label={t.history}
      className="rounded-xl border border-cafe-subtle bg-[var(--shell-paper,var(--cafe-surface))] p-4"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">{t.issues}</h2>
      </div>
      <p className="mt-1 text-xs text-cafe-muted">{t.exceptions}</p>
      {pending && <output className="mt-3 text-xs text-cafe-secondary">{t.pending}</output>}
      {(error || failure) && (
        <p role="alert" className="mt-3 text-xs text-cafe-secondary">
          {failure ?? error}
        </p>
      )}
      {!review ? (
        <p className="mt-3 text-xs text-cafe-muted">{t.readingIssues}</p>
      ) : !annotations.length ? (
        <p className="mt-3 text-xs text-cafe-muted">{t.noIssues}</p>
      ) : (
        <ul className="mt-4 space-y-5">
          {annotations.map((annotation) => {
            const history = annotation.projectHistory ?? [];
            const { answered, modified, canCompare, label } = opinionStatus(annotation, t);
            return (
              <li key={annotation.id} className="border-t border-cafe-subtle pt-3 text-sm">
                <div className="flex justify-between gap-2 text-xs text-cafe-secondary">
                  <div>
                    <ReviewPerson actor={annotation.author} /> ·{' '}
                    {annotation.projectMessage
                      ? t.input(annotation.projectMessage.input.ownerRevision)
                      : t.projectOpinion}
                  </div>
                  <span>{label}</span>
                </div>
                <OpinionBody annotation={annotation} onLocate={() => onLocate(annotation)} />
                {annotation.projectMessage?.sourceState === 'changed' && (
                  <p className="mt-1 text-xs text-cafe-muted">{t.sourceChanged}</p>
                )}
                <OpinionHistory history={history} />
                <OpinionActions
                  answered={answered}
                  modified={modified}
                  canCompare={canCompare}
                  busy={busy !== null}
                  onCompare={() => onCompare(annotation)}
                  onReopen={() => {
                    setReopening(annotation.id);
                    setReason('');
                  }}
                />
                {reopening === annotation.id && (
                  <div className="mt-3">
                    <label className="text-xs">
                      {t.reopenReason}
                      <input
                        value={reason}
                        onChange={(event) => setReason(event.target.value)}
                        className="mt-1 block w-full rounded border border-cafe-subtle bg-cafe-surface px-2 py-1"
                      />
                    </label>
                    <div className="mt-2 flex gap-3">
                      <button
                        type="button"
                        disabled={busy !== null || !reason.trim()}
                        onClick={() => void reopen(annotation)}
                      >
                        {t.reopen}
                      </button>
                      <button type="button" onClick={() => setReopening(null)}>
                        {t.cancel}
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}

function OpinionBody({ annotation, onLocate }: { annotation: WorkspaceContentAnnotation; onLocate: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const t = useScreeningCopy();
  return (
    <>
      <button
        type="button"
        onClick={onLocate}
        className={`mt-2 w-full text-left leading-relaxed ${expanded ? '' : 'line-clamp-3'}`}
      >
        {annotation.body}
      </button>
      <button
        type="button"
        aria-expanded={expanded}
        className="mt-1 text-xs text-cafe-muted underline"
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? t.expanded : t.expand}
      </button>
    </>
  );
}
