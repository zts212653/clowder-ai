import type { ArtifactReviewRound } from '@cat-cafe/shared';
import { ReviewActor } from './ReviewActor';
import { ReviewHistory } from './ReviewHistory';
import { ReviewToolbarIcon } from './ReviewToolbarIcon';
import toolbar from './review-toolbar.module.css';
import styles from './review-workspace.module.css';

export function ReviewVersionDetails({
  round,
  reviewId,
  revision,
  ownerUserId,
  onClose,
  onPreviousRound,
}: {
  round: ArtifactReviewRound;
  reviewId: string;
  revision: number;
  ownerUserId: string;
  onClose: () => void;
  onPreviousRound: () => void;
}) {
  return (
    <aside className={styles.drawer} aria-label="版本与历史">
      <div className={styles.drawerHeader}>
        <h3 className={styles.drawerTitle}>
          <ReviewToolbarIcon name="history" />
          版本与历史
        </h3>
        <button type="button" className={toolbar.iconButton} aria-label="关闭审阅详情" onClick={onClose}>
          <ReviewToolbarIcon name="close" />
        </button>
      </div>
      <div className={styles.drawerBody}>
        {round.responses.length ? (
          <section className="rounded-xl border border-cafe-subtle p-4" aria-label="猫对上一版的回应">
            <h3 className="text-sm font-semibold text-cafe-black">这一版怎样回应了你的意见</h3>
            {round.responseAuthor ? (
              <div className="mt-2">
                <ReviewActor actor={round.responseAuthor} ownerUserId={ownerUserId} />
              </div>
            ) : null}
            <ol className="mt-3 space-y-2">
              {round.responses.map((response) => (
                <li key={response.annotationId} className="text-sm leading-6 text-cafe-secondary">
                  <span className="mr-2 text-xs font-semibold text-cafe-accent">
                    {response.disposition === 'addressed' ? '已调整' : '保留原样'}
                  </span>
                  <span className="whitespace-pre-wrap break-words">{response.explanation}</span>
                  <button type="button" className="ml-2 text-xs text-cafe-accent" onClick={onPreviousRound}>
                    看原标注
                  </button>
                </li>
              ))}
            </ol>
          </section>
        ) : null}
        <ReviewHistory reviewId={reviewId} revision={revision} ownerUserId={ownerUserId} />
      </div>
    </aside>
  );
}
