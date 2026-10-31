import type { ArtifactReviewAction, ArtifactReviewRound } from '@cat-cafe/shared';
import Image from 'next/image';
import { type ReactNode, useRef, useState } from 'react';
import { ReviewRoundDecision } from '@/components/content-review/ReviewRoundDecision';
import { reviewDecisionCopy } from '@/components/content-review/review-decision.shell-copy';
import { reviewDraftPrefix, useArtifactReview } from '@/components/content-review/useArtifactReview';
import { useReviewMediaSource } from '@/components/content-review/useReviewMediaSource';
import { useShellCopy } from '../shell-copy';
import { useShellLanguage } from '../shell-language';
import { type MailboxReviewSource, matchesMailboxReview } from './mailbox-review-match';

function Preview({
  source,
  round,
  revoke,
}: {
  source: MailboxReviewSource;
  round: ArtifactReviewRound;
  revoke: () => void;
}) {
  const t = useShellCopy(reviewDecisionCopy);
  const { src, error } = useReviewMediaSource(source.reviewId, round.number, revoke);
  if (!src)
    return (
      <p className="text-xs" role={error ? 'alert' : undefined}>
        {error ? t.mismatch : t.checking}
      </p>
    );
  return round.asset.media.kind === 'image' ? (
    <Image
      unoptimized
      src={src}
      alt={t.preview}
      width={round.asset.media.width}
      height={round.asset.media.height}
      className="max-h-80 w-full object-contain"
    />
  ) : (
    <video controls src={src} aria-label={t.preview} className="max-h-80 w-full">
      <track kind="captions" />
    </video>
  );
}

/** Original GET, draft and CAS writer; this host only checks the source currently displayed. */
export function MailboxReviewCard({
  source,
  readCurrent,
  verifyCurrentRead,
  secondaryActions,
}: {
  source: MailboxReviewSource;
  readCurrent: boolean;
  verifyCurrentRead: () => boolean;
  secondaryActions?: ReactNode;
}) {
  const t = useShellCopy(reviewDecisionCopy);
  const controller = useArtifactReview(source.reviewId);
  const language = useShellLanguage();
  const latest = useRef({ source, readCurrent, verifyCurrentRead, view: controller.view });
  latest.current = { source, readCurrent, verifyCurrentRead, view: controller.view };
  const inFlight = useRef(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [submitted, setSubmitted] = useState<{ round: number; outcome: 'approved' | 'changes_requested' } | null>(null);
  const matched = controller.view && matchesMailboxReview(source, controller.view);
  const canWrite = Boolean(readCurrent && matched);
  async function act(action: ArtifactReviewAction, round: number): Promise<boolean> {
    const current = latest.current;
    if (
      inFlight.current ||
      !current.readCurrent ||
      !current.verifyCurrentRead() ||
      !current.view ||
      !matchesMailboxReview(current.source, current.view) ||
      current.view.review.rounds.at(-1)?.number !== round ||
      action.kind !== 'decide'
    )
      return false;
    inFlight.current = true;
    try {
      const written = await controller.act(action, round);
      if (written) setSubmitted({ round, outcome: action.outcome });
      return written;
    } finally {
      inFlight.current = false;
    }
  }
  async function retry() {
    const current = latest.current;
    if (
      inFlight.current ||
      !current.readCurrent ||
      !current.verifyCurrentRead() ||
      !current.view ||
      !matchesMailboxReview(current.source, current.view)
    )
      return;
    inFlight.current = true;
    try {
      const command = controller.pending;
      if ((await controller.retry()) && command?.action.kind === 'decide') {
        setSubmitted({ round: command.round, outcome: command.action.outcome });
      }
    } finally {
      inFlight.current = false;
    }
  }
  const round = controller.view?.review.rounds.at(-1);
  const review = controller.view?.review;
  const decision = round?.decision;
  const confirmed = Boolean(
    submitted &&
      review &&
      round &&
      decision &&
      review.reviewId === source.reviewId &&
      review.task.ownerUserId === source.ownerUserId &&
      `task:work:${review.task.taskId}` === source.taskRef &&
      review.task.observedRevision === source.taskRevision &&
      review.revision > source.reviewRevision &&
      round.number === submitted.round &&
      decision.outcome === submitted.outcome &&
      round.state === decision.outcome &&
      decision.actor.kind === 'human' &&
      decision.actor.actorId === source.ownerUserId &&
      decision.receiptRef,
  );
  return (
    <div className="space-y-3" data-testid="mailbox-review-card">
      {confirmed && decision ? (
        <output className="block text-sm font-medium" data-testid="mailbox-review-result">
          {decision.outcome === 'approved' ? t.approved : t.changes} ·{' '}
          {new Intl.DateTimeFormat(language === 'en' ? 'en-US' : 'zh-CN', {
            month: 'numeric',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          }).format(new Date(decision.decidedAt))}{' '}
          · {t.you}
        </output>
      ) : matched && round && controller.view ? (
        <>
          <div className="flex min-w-0 items-baseline gap-2">
            <h3 className="min-w-0 flex-1 break-words text-sm font-semibold">{controller.view.review.title}</h3>
            <span className="flex-none text-xs" style={{ color: 'var(--shell-muted)' }}>
              {t.version(round.number)}
            </span>
          </div>
          <details onToggle={(event) => setPreviewOpen(event.currentTarget.open)}>
            <summary className="shell-focusable cursor-pointer text-xs">{t.preview}</summary>
            {previewOpen ? <Preview source={source} round={round} revoke={controller.revokeAccess} /> : null}
          </details>
          <ReviewRoundDecision
            placement="inbox"
            round={round}
            ownerUserId={source.ownerUserId}
            canWrite={canWrite}
            saving={controller.saving || Boolean(controller.pending)}
            draftKey={`${reviewDraftPrefix(source.ownerUserId, source.reviewId)}round:${round.number}:decision`}
            act={act}
          />
        </>
      ) : (
        <p className="text-sm" role={controller.loading ? undefined : 'status'}>
          {controller.loading ? t.checking : t.mismatch}
        </p>
      )}
      {controller.error ? (
        <p role="alert" className="text-xs">
          {t.mismatch}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-2" data-testid="mailbox-row-secondary-actions">
        <button
          type="button"
          className="shell-focusable text-xs"
          disabled={controller.saving}
          onClick={() => void controller.refresh()}
        >
          {t.reread}
        </button>
        {controller.pending ? (
          <button
            type="button"
            className="shell-focusable text-xs"
            disabled={!readCurrent || !matched || controller.saving}
            onClick={() => void retry()}
          >
            {t.retry}
          </button>
        ) : null}
        {secondaryActions}
      </div>
    </div>
  );
}
