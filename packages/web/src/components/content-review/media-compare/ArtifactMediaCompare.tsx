'use client';
import { useState } from 'react';
import type { ContentReviewController } from '@/components/workbench/content-review/content-review-contract';
import type { ArtifactRoundProps } from '../ArtifactRoundLanding';
import { ReviewRoundDecision } from '../ReviewRoundDecision';
import { MediaVersionCompare } from './MediaVersionCompare';
import { reviewAuthorityMessages } from './review-authority-messages';

export function ArtifactMediaCompare({
  view,
  round,
  controller,
  recovery,
  prefix,
  canWrite,
  onClose,
  onBack,
}: Pick<ArtifactRoundProps, 'view' | 'round' | 'controller' | 'prefix' | 'onBack'> & {
  canWrite: boolean;
  recovery?: Pick<ContentReviewController, 'pending' | 'busy' | 'error' | 'retryPending'>;
  onClose: () => void;
}) {
  const pending = Boolean(controller.pending) || Boolean(recovery?.pending);
  const saving = controller.saving || Boolean(recovery?.busy);
  const error = recovery?.error ?? controller.error;
  const buttonClass =
    'rounded-lg border border-cafe-subtle px-3 py-1.5 hover:bg-cafe-surface-elevated focus-visible:outline focus-visible:outline-cafe-accent disabled:opacity-40';
  const prior = view.review.rounds.filter((item) => item.number < round.number);
  const [originalNumber, setOriginal] = useState(prior.at(-1)?.number ?? round.number);
  const original = prior.find((item) => item.number === originalNumber);
  const mediaPath = (number: number) =>
    `/api/artifact-reviews/${encodeURIComponent(view.review.reviewId)}/media/${number}`;
  return (
    <section className="flex min-h-0 flex-1 flex-col" data-testid="artifact-media-compare">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-cafe-subtle px-3 py-2 text-xs">
        <button type="button" className={buttonClass} onClick={onClose}>
          返回作品
        </button>
        <span className="min-w-0 flex-1 truncate">{view.review.title}</span>
        <label>
          原版{' '}
          <select
            aria-label="对比原版"
            value={original?.number ?? ''}
            onChange={(event) => setOriginal(Number(event.target.value))}
          >
            {prior.map((item) => (
              <option key={item.number} value={item.number}>
                第 {item.number} 版
              </option>
            ))}
          </select>
        </label>
        <button type="button" className={buttonClass} onClick={onBack}>
          返回来源
        </button>
      </header>
      {error ? (
        <p role="alert" className="px-3 py-2 text-sm text-cafe-error">
          {error}
        </p>
      ) : null}
      {pending ? (
        <div className="px-3 py-2 text-sm text-cafe-muted">
          <p role="status">
            {controller.pending
              ? '保存结果尚未确认；此版本与判断草稿已保留。'
              : '讨论保存结果尚未确认；原操作与草稿已保留。'}
          </p>
          <button
            type="button"
            className={buttonClass}
            disabled={saving}
            onClick={() => void (controller.pending ? controller.retry() : recovery?.retryPending())}
          >
            重试原保存操作
          </button>
        </div>
      ) : null}
      {view.authority.state !== 'current' ? (
        <p role="status" className="px-3 py-2 text-sm text-cafe-muted">
          {reviewAuthorityMessages[view.authority.state]}
        </p>
      ) : null}
      {original ? (
        <MediaVersionCompare
          original={{ asset: original.asset, label: '原版', mediaPath: mediaPath(original.number) }}
          candidate={{ asset: round.asset, label: '候选版本', mediaPath: mediaPath(round.number) }}
          onUnavailable={controller.revokeAccess}
          decision={
            <ReviewRoundDecision
              round={round}
              ownerUserId={view.review.task.ownerUserId}
              canWrite={canWrite && round.number === view.review.rounds.at(-1)?.number}
              saving={controller.saving}
              draftKey={`${prefix}round:${round.number}:decision`}
              act={controller.act}
              compact
            />
          }
        />
      ) : (
        <p role="status">原版当前无法核对，请返回作品刷新。</p>
      )}
    </section>
  );
}
