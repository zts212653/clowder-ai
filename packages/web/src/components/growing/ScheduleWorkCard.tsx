import type { ArtifactReviewView, EntrustedWorkOwnerReadV1 } from '@cat-cafe/shared';
import { collectiveWorkDatesActionRef } from '@cat-cafe/shared';
import Link from 'next/link';
import type { Ref } from 'react';
import { CatAvatar } from '@/components/CatAvatar';
import { useShellCopy } from '@/components/shell/shell-copy';
import { useCatData } from '@/hooks/useCatData';
import { resolveCatDisplayName } from '@/lib/cat-display-name';
import { EntrustedWorkBrief } from './EntrustedWorkBrief';
import type { PreparedArtifactCoordinate } from './ProductSchedulePanel';
import { preparedArtifactPresentation, preparedReviewCoordinate } from './prepared-artifact-presentation';
import { usePreparedReviewTitle } from './prepared-review-presentation';
import { scheduleCopy } from './product-schedule.shell-copy';
import { ScheduleArtifactActions } from './ScheduleArtifactActions';
import { SchedulePersonalActions } from './SchedulePersonalActions';
import { workDates, workTitle } from './work-calendar';

export function ScheduleWorkCard({
  ownerRead,
  currentTime,
  itemRef,
  selected,
  dateSelected = false,
  selectedRef,
  artifactsLoading,
  onOpenArtifact,
  onOpenReview,
  personal,
}: {
  ownerRead: EntrustedWorkOwnerReadV1;
  currentTime: number;
  itemRef: string;
  selected: boolean;
  dateSelected?: boolean;
  selectedRef?: Ref<HTMLElement>;
  artifactsLoading: boolean;
  onOpenArtifact?: (artifact: PreparedArtifactCoordinate, itemRef: string, title?: string) => void;
  onOpenReview?: (review: ArtifactReviewView, itemRef: string) => void;
  personal?: { ignored: boolean; disabled: boolean; onChange: (ignored: boolean) => void };
}) {
  const t = useShellCopy(scheduleCopy);
  const dateLabel = (value: number) =>
    new Intl.DateTimeFormat(t.locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(
      value,
    );
  const { getCatById } = useCatData({ fetch: false });
  const { work, brief } = ownerRead;
  const preparedReview = preparedReviewCoordinate(ownerRead.preparedArtifact?.previewRef);
  const reviewTitle = usePreparedReviewTitle(preparedReview?.reviewId ?? null);
  const catId = work?.ownerCatId;
  const completed = Boolean(ownerRead.completion);
  const blocked = brief.current.state === 'blocked';
  const dates = workDates(ownerRead);
  const due = dates.find((time) => time.role === 'business_deadline');
  const needsMe = brief.needsMe.state === 'needed';
  return (
    <article
      ref={selectedRef}
      data-testid="product-schedule-item"
      data-item-ref={itemRef}
      data-selected={selected}
      data-date-selected={dateSelected}
      data-subject-ref={ownerRead.envelope.subjectRef}
      data-owner-ref={ownerRead.envelope.ownerRef}
      data-owner-revision={ownerRead.envelope.revision}
      className={`min-w-0 rounded-xl border bg-[var(--console-card-bg)] p-4 ${selected || dateSelected ? 'border-cafe-accent ring-2 ring-cafe-accent/15' : 'border-cafe-subtle/80'}`}
    >
      <div className="flex items-center justify-between gap-2">
        <div data-testid="work-owner" className="flex min-w-0 items-center gap-2 text-xs text-cafe-secondary">
          {catId ? (
            <>
              <CatAvatar catId={catId} size={24} />
              <span className="truncate">{resolveCatDisplayName(catId, getCatById)}</span>
            </>
          ) : (
            <span>{t.ownerUnknown}</span>
          )}
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-1 text-micro font-semibold ${completed ? 'bg-semantic-success-surface text-semantic-success' : blocked ? 'bg-semantic-critical-surface text-semantic-critical' : 'bg-cafe-accent/10 text-cafe-accent'}`}
        >
          {t.status[brief.current.state]}
        </span>
      </div>
      <h3 className="mt-3 break-words text-base font-semibold leading-6 text-cafe-black">{workTitle(ownerRead)}</h3>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-cafe-secondary">
        {work ? (
          <span>
            {t.time.admitted_at} · {dateLabel(work.admittedAt)}
          </span>
        ) : null}
        {dates.map((time) => (
          <span
            key={time.role}
            className={
              !completed && time.role === 'business_deadline' && time.value < currentTime
                ? 'font-medium text-semantic-critical'
                : ''
            }
          >
            {t.time[time.role]} · {dateLabel(time.value)}
            {!completed && time.role === 'business_deadline' && time.value < currentTime
              ? ` · ${t.overdueDays(Math.floor((currentTime - time.value) / 86400000))}`
              : ''}
          </span>
        ))}
        {!due && !completed ? <span>{t.deadlineUnknown}</span> : null}
        {ownerRead.completion?.recordedAt !== undefined ? (
          <span className="text-semantic-success">
            {t.time.completed_at} · {dateLabel(ownerRead.completion.recordedAt)}
          </span>
        ) : null}
        {completed && ownerRead.completion?.recordedAt === undefined ? <span>{t.completedTimeUnknown}</span> : null}
      </div>
      {ownerRead.publicTime?.state === 'unavailable' ? (
        <p className="mt-2 text-xs text-cafe-muted">{t.collectiveDatesUnavailable}</p>
      ) : null}
      <OwnerProgress ownerRead={ownerRead} blocked={blocked} />
      {needsMe ? <p className="mt-2 text-xs font-semibold text-cafe-accent">{t.needsJudgment}</p> : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {personal ? <SchedulePersonalActions ownerRead={ownerRead} {...personal} /> : null}
        <ScheduleArtifactActions
          ownerRead={ownerRead}
          itemRef={itemRef}
          artifactsLoading={artifactsLoading}
          displayTitle={reviewTitle}
          onOpenArtifact={onOpenArtifact}
          onOpenReview={onOpenReview}
        />
        {ownerRead.publicTime?.state === 'current' ? (
          <Link
            className="rounded-lg border border-cafe-subtle px-3 py-2 text-xs text-cafe-secondary"
            href={collectiveWorkDatesActionRef({
              connectionId: ownerRead.publicTime.connectionId,
              channelId: ownerRead.publicTime.location.channelId,
              workId: ownerRead.publicTime.workId,
              workRevision: ownerRead.publicTime.workRevision,
            })}
          >
            {t.collectiveDatesOrigin}
          </Link>
        ) : null}
        {work ? (
          <Link
            href={`/thread/${encodeURIComponent(work.threadId)}`}
            className="rounded-lg border border-cafe-subtle px-3 py-2 text-xs font-medium text-cafe-secondary hover:border-cafe-accent/40 hover:text-cafe-accent"
          >
            {t.origin} →
          </Link>
        ) : null}
        {!ownerRead.preparedArtifact ? (
          <span className="text-xs text-cafe-muted">{completed ? t.archivedUnconfirmed : t.artifactUnconfirmed}</span>
        ) : null}
      </div>
      <details className="mt-3 border-t border-cafe-subtle/50 pt-2 text-xs text-cafe-muted">
        <summary className="cursor-pointer">{t.goal}</summary>
        {work?.ownerNote ? <p className="mt-2 whitespace-pre-wrap break-words leading-5">{work.ownerNote}</p> : null}
      </details>
      <details className="mt-2 text-xs text-cafe-muted">
        <summary className="cursor-pointer">{t.engineering}</summary>
        <EntrustedWorkBrief
          ownerRead={ownerRead}
          artifactLabel={
            ownerRead.preparedArtifact
              ? preparedArtifactPresentation(ownerRead.preparedArtifact, undefined, reviewTitle).label
              : undefined
          }
        />
        {ownerRead.completion ? (
          <p className="mt-2 break-all">
            {t.completionEvidence} · {ownerRead.completion.evidenceRefs.join(' / ')}
          </p>
        ) : null}
      </details>
    </article>
  );
}

function OwnerProgress({ ownerRead, blocked }: { ownerRead: EntrustedWorkOwnerReadV1; blocked: boolean }) {
  const t = useShellCopy(scheduleCopy);
  if (ownerRead.completion) return null;
  const progress = ownerRead.work?.progress;
  const summary = progress?.summary ?? t.progressMissing;
  return (
    <div data-testid="work-owner-note" className="mt-3 space-y-2 text-xs leading-5 text-cafe-secondary">
      <p className="font-semibold text-cafe-secondary">{t.progress}</p>
      <p className="whitespace-pre-wrap break-words">{summary}</p>
      {progress ? <p className="text-cafe-muted">{t.progressTimeMissing}</p> : null}
      {progress?.nextStep ? (
        <p>
          <span className="text-cafe-muted">{t.next} · </span>
          {progress.nextStep}
        </p>
      ) : null}
      {blocked ? (
        <p className="rounded-lg bg-semantic-critical-surface px-3 py-2 text-semantic-critical">
          {progress?.blockerReason ?? t.blockerMissing}
        </p>
      ) : null}
    </div>
  );
}
