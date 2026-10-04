import type { ArtifactReviewView, EntrustedWorkOwnerReadV1 } from '@cat-cafe/shared';
import Link from 'next/link';
import type { Ref } from 'react';
import { CatAvatar } from '@/components/CatAvatar';
import { useCatData } from '@/hooks/useCatData';
import { resolveCatDisplayName } from '@/lib/cat-display-name';
import { EntrustedWorkBrief } from './EntrustedWorkBrief';
import type { PreparedArtifactCoordinate } from './ProductSchedulePanel';
import { preparedArtifactPresentation, preparedReviewCoordinate } from './prepared-artifact-presentation';
import { usePreparedReviewTitle } from './prepared-review-presentation';
import { ScheduleArtifactActions } from './ScheduleArtifactActions';
import { WORK_STATUS, WORK_TIME, workDates, workTitle } from './work-calendar';

const dateLabel = (value: number) =>
  new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(
    value,
  );

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
}) {
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
            <span>负责人未提供</span>
          )}
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-1 text-micro font-semibold ${completed ? 'bg-semantic-success-surface text-semantic-success' : blocked ? 'bg-semantic-critical-surface text-semantic-critical' : 'bg-cafe-accent/10 text-cafe-accent'}`}
        >
          {WORK_STATUS[brief.current.state]}
        </span>
      </div>
      <h3 className="mt-3 break-words text-base font-semibold leading-6 text-cafe-black">{workTitle(ownerRead)}</h3>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-cafe-secondary">
        {work ? <span>{dateLabel(work.admittedAt)} 接下</span> : null}
        {dates.map((time) => (
          <span
            key={time.role}
            className={
              !completed && time.role === 'business_deadline' && time.value < currentTime
                ? 'font-medium text-semantic-critical'
                : ''
            }
          >
            {WORK_TIME[time.role]} · {dateLabel(time.value)}
            {!completed && time.role === 'business_deadline' && time.value < currentTime ? ' · 已逾期' : ''}
          </span>
        ))}
        {!due && !completed ? <span>截止未定</span> : null}
        {ownerRead.completion?.recordedAt !== undefined ? (
          <span className="text-semantic-success">{dateLabel(ownerRead.completion.recordedAt)} 完成</span>
        ) : null}
        {completed && ownerRead.completion?.recordedAt === undefined ? <span>完成时间未记录</span> : null}
      </div>
      <OwnerProgress ownerRead={ownerRead} blocked={blocked} />
      {needsMe ? <p className="mt-2 text-xs font-semibold text-cafe-accent">需要你判断</p> : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <ScheduleArtifactActions
          ownerRead={ownerRead}
          itemRef={itemRef}
          artifactsLoading={artifactsLoading}
          displayTitle={reviewTitle}
          onOpenArtifact={onOpenArtifact}
          onOpenReview={onOpenReview}
        />
        {work ? (
          <Link
            href={`/thread/${encodeURIComponent(work.threadId)}`}
            className="rounded-lg border border-cafe-subtle px-3 py-2 text-xs font-medium text-cafe-secondary hover:border-cafe-accent/40 hover:text-cafe-accent"
          >
            回原对话 →
          </Link>
        ) : null}
        {!ownerRead.preparedArtifact ? (
          <span className="text-xs text-cafe-muted">{completed ? '交付材料未封存或已变更' : '尚无已发布成果'}</span>
        ) : null}
      </div>
      <details className="mt-3 border-t border-cafe-subtle/50 pt-2 text-xs text-cafe-muted">
        <summary className="cursor-pointer">目标与来源</summary>
        {work?.ownerNote ? <p className="mt-2 whitespace-pre-wrap break-words leading-5">{work.ownerNote}</p> : null}
        <EntrustedWorkBrief
          ownerRead={ownerRead}
          artifactLabel={
            ownerRead.preparedArtifact
              ? preparedArtifactPresentation(ownerRead.preparedArtifact, undefined, reviewTitle).label
              : undefined
          }
        />
        {ownerRead.completion ? (
          <p className="mt-2 break-all">完成依据 · {ownerRead.completion.evidenceRefs.join(' / ')}</p>
        ) : null}
      </details>
    </article>
  );
}

function OwnerProgress({ ownerRead, blocked }: { ownerRead: EntrustedWorkOwnerReadV1; blocked: boolean }) {
  if (ownerRead.completion) return null;
  const progress = ownerRead.work?.progress;
  const summary = progress?.summary ?? '尚无进展说明';
  return (
    <div data-testid="work-owner-note" className="mt-3 space-y-2 text-xs leading-5 text-cafe-secondary">
      <p className="line-clamp-2">{summary}</p>
      {progress?.nextStep ? (
        <p>
          <span className="text-cafe-muted">下一步 · </span>
          {progress.nextStep}
        </p>
      ) : null}
      {blocked ? (
        <p className="rounded-lg bg-semantic-critical-surface px-3 py-2 text-semantic-critical">
          {progress?.blockerReason ?? '原记录尚未说明阻塞原因'}
        </p>
      ) : null}
    </div>
  );
}
