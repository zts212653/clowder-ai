'use client';
import type { ArtifactReviewView } from '@cat-cafe/shared';
import { useState } from 'react';
import { ReviewRoundWorkspace } from './ReviewRoundWorkspace';
import { ReviewToolbarIcon } from './ReviewToolbarIcon';
import { ReviewVersionDetails } from './ReviewVersionDetails';
import toolbar from './review-toolbar.module.css';
import styles from './review-workspace.module.css';
import { startReviewReanchor } from './startReviewReanchor';
import { reviewDraftPrefix, useArtifactReview } from './useArtifactReview';

const states = {
  draft: '一起审阅',
  awaiting_human: '等待你的判断',
  approved: '这版已通过',
  changes_requested: '请猫继续修改',
  superseded: '历史版本',
};
const authorityMessages = {
  current: '',
  task_changed: '原任务已有变化。你可以查看记录，请负责的猫核对原任务后再次发起审阅。',
  task_closed: '原任务已收口，审阅记录与历史版本继续保留。',
  asset_changed: '媒体已有新变化，请刷新并核对当前版本后继续。',
};

export function ArtifactReviewSurface({ reviewId, onBack }: { reviewId: string; onBack: () => void }) {
  const review = useArtifactReview(reviewId);
  return (
    <section className={styles.surface} data-testid="artifact-review-surface">
      {!review.view ? (
        <div className={styles.topbar}>
          <button type="button" onClick={onBack} className={styles.back} aria-label="← 回到原处">
            <ReviewToolbarIcon name="view" />
            返回
          </button>
          <button type="button" onClick={() => void review.refresh()} className="text-xs text-cafe-muted">
            刷新
          </button>
        </div>
      ) : null}
      {review.error ? (
        <div
          role="alert"
          className="mx-4 mt-3 rounded-lg border border-cafe-error/25 bg-cafe-error/5 p-3 text-sm text-cafe-secondary"
        >
          {review.error}
        </div>
      ) : null}
      {review.pending ? (
        <div role="status" className="mx-4 mt-3 rounded-lg bg-cafe-accent/10 p-3 text-xs text-cafe-secondary">
          上一项保存尚未确认。
          <button
            type="button"
            disabled={review.saving}
            onClick={() => void review.retry()}
            className="ml-2 font-semibold text-cafe-accent"
          >
            重试原操作
          </button>
        </div>
      ) : null}
      {review.view ? (
        <AuthorizedReview key={reviewId} view={review.view} controller={review} onBack={onBack} />
      ) : (
        <div className="grid min-h-48 flex-1 place-items-center p-6 text-sm text-cafe-muted">
          {review.loading ? '正在从原任务恢复审阅…' : '刷新后继续查看这份审阅。'}
        </div>
      )}
    </section>
  );
}

function AuthorizedReview({
  view,
  controller,
  onBack,
}: {
  view: ArtifactReviewView;
  controller: ReturnType<typeof useArtifactReview>;
  onBack: () => void;
}) {
  const latest = view.review.rounds.at(-1);
  const [roundNumber, setRoundNumber] = useState(latest?.number ?? 1);
  const [draftNotice, setDraftNotice] = useState<string | null>(null);
  const [panel, setPanel] = useState<'comments' | 'decision' | 'details' | null>(null);
  const round = view.review.rounds.find((item) => item.number === roundNumber) ?? latest;
  if (!round || !latest) return null;
  const prefix = reviewDraftPrefix(view.review.task.ownerUserId, view.review.reviewId);
  const historical = round.number !== latest.number;
  const delivery = view.continuation.returnDelivery;
  const returnLabel = delivery?.kind === 'request_image_edit' ? '修改请求' : '结论';
  return (
    <div className={styles.authorized}>
      <header className={styles.header}>
        <button
          type="button"
          onClick={onBack}
          className={toolbar.iconButton}
          aria-label="← 回到原处"
          title="回到原任务"
        >
          <ReviewToolbarIcon name="view" />
        </button>
        <div className="min-w-0">
          <h2 className={styles.title} title={view.review.title}>
            {view.review.title}
          </h2>
          <div className={styles.subtitle}>
            <span className={styles.statusDot} aria-hidden />
            {states[round.state]}
            <span>·</span>
            <label>
              <span className="sr-only">版本</span>
              <select
                aria-label="审阅版本"
                value={round.number}
                onChange={(event) => {
                  setRoundNumber(Number(event.target.value));
                  setPanel(null);
                }}
                className={styles.version}
              >
                {view.review.rounds.map((item) => (
                  <option key={item.number} value={item.number}>
                    第 {item.number} 版{item.number === latest.number ? ' · 最新' : ''}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.badgeButton}
            aria-label={`查看讨论 ${round.annotations.length} 条`}
            title="一起讨论"
            onClick={() => setPanel(panel === 'comments' ? null : 'comments')}
          >
            <ReviewToolbarIcon name="comment" />
            <span>{round.annotations.length}</span>
          </button>
          <button
            type="button"
            className={toolbar.iconButton}
            aria-label="完成审阅"
            title="完成审阅"
            onClick={() => setPanel(panel === 'decision' ? null : 'decision')}
          >
            <span className="text-semantic-success">
              <ReviewToolbarIcon name="check" />
            </span>
          </button>
          <button
            type="button"
            className={toolbar.iconButton}
            aria-label="审阅详情"
            title="版本、回应与历史"
            onClick={() => setPanel(panel === 'details' ? null : 'details')}
          >
            <ReviewToolbarIcon name="history" />
          </button>
          <button
            type="button"
            className={toolbar.iconButton}
            aria-label="刷新"
            title="刷新审阅"
            onClick={() => void controller.refresh()}
          >
            <ReviewToolbarIcon name="refresh" />
          </button>
        </div>
      </header>
      {view.authority.state !== 'current' ? (
        <p role="status" className={styles.notice}>
          {authorityMessages[view.authority.state]}
        </p>
      ) : null}
      {view.pendingVersion ? (
        <p role="status" className={styles.notice}>
          新版正在保存和恢复，旧版讨论仍然完整保留。
        </p>
      ) : null}
      {historical ? (
        <div className={styles.notice}>
          正在看第 {round.number} 版，标注对应这一版的原画面。
          <button
            type="button"
            className="font-semibold text-cafe-accent"
            onClick={() => setRoundNumber(latest.number)}
          >
            查看最新第 {latest.number} 版
          </button>
        </div>
      ) : null}
      {delivery ? (
        <p role="status" data-testid="review-return-state" className={styles.notice}>
          {delivery.state === 'pending'
            ? `${returnLabel}已保存，正在交还原任务；关闭页面后仍会继续投递。`
            : delivery.state === 'queued'
              ? `${returnLabel}已交还原任务队列。`
              : '原任务或审阅版本已有变化，旧回流已撤回；历史结论仍保留。'}
        </p>
      ) : null}
      {draftNotice ? (
        <p role="status" className={styles.notice}>
          {draftNotice}
        </p>
      ) : null}
      <ReviewRoundWorkspace
        key={round.number}
        view={view}
        roundNumber={round.number}
        historical={historical}
        prefix={prefix}
        controller={controller}
        panel={panel}
        onPanelChange={setPanel}
        onReanchor={
          historical && view.authority.canWrite && latest.state !== 'approved' && !controller.pending
            ? (annotation) => {
                const result = startReviewReanchor(`${prefix}round:${latest.number}:annotation`, {
                  body: annotation.body,
                  anchor: null,
                  reanchoredFrom: { round: round.number, annotationId: annotation.id },
                });
                setDraftNotice(
                  result === 'existing'
                    ? '新版还有未保存的标注，已为你保留。请先保存或清空这条草稿，再从旧版重新圈选。'
                    : result === 'unavailable'
                      ? '暂时无法保存重新圈选的草稿，原标注仍然保留。请腾出浏览器存储空间后重试。'
                      : null,
                );
                if (result !== 'unavailable') {
                  setRoundNumber(latest.number);
                  setPanel(null);
                }
              }
            : undefined
        }
      />
      {panel === 'details' ? (
        <ReviewVersionDetails
          round={round}
          reviewId={view.review.reviewId}
          revision={view.review.revision}
          ownerUserId={view.review.task.ownerUserId}
          onClose={() => setPanel(null)}
          onPreviousRound={() => {
            setRoundNumber(round.number - 1);
            setPanel('comments');
          }}
        />
      ) : null}
    </div>
  );
}
