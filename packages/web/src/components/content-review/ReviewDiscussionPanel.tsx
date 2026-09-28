import type { ArtifactReviewAnnotation, ArtifactReviewRound, ArtifactReviewView } from '@cat-cafe/shared';
import { ReviewComments } from './ReviewComments';
import { ReviewRoundDecision } from './ReviewRoundDecision';
import { ReviewToolbarIcon } from './ReviewToolbarIcon';
import toolbar from './review-toolbar.module.css';
import styles from './review-workspace.module.css';
import type { useArtifactReview } from './useArtifactReview';

export function ReviewDiscussionPanel({
  panel,
  round,
  view,
  prefix,
  canWrite,
  historical,
  controller,
  activeId,
  focusRequest,
  onActive,
  onReturnToCanvas,
  onReanchor,
  onClose,
}: {
  panel: 'comments' | 'decision';
  round: ArtifactReviewRound;
  view: ArtifactReviewView;
  prefix: string;
  canWrite: boolean;
  historical: boolean;
  controller: ReturnType<typeof useArtifactReview>;
  activeId: string | null;
  focusRequest: { annotationId: string; requestId: number } | null;
  onActive: (id: string) => void;
  onReturnToCanvas: (id: string) => void;
  onReanchor?: ((annotation: ArtifactReviewAnnotation) => void) | undefined;
  onClose: () => void;
}) {
  return (
    <aside className={styles.drawer} aria-label={panel === 'comments' ? '作品讨论' : '审阅结论'}>
      <div className={styles.drawerHeader}>
        <h3 className={styles.drawerTitle}>
          <ReviewToolbarIcon name={panel === 'comments' ? 'comment' : 'check'} />
          {panel === 'comments' ? '一起讨论' : '完成这一版审阅'}
        </h3>
        <button type="button" className={toolbar.iconButton} aria-label="关闭审阅面板" onClick={onClose}>
          <ReviewToolbarIcon name="close" />
        </button>
      </div>
      <div className={styles.drawerBody}>
        {panel === 'comments' ? (
          <ReviewComments
            round={round}
            ownerUserId={view.review.task.ownerUserId}
            draftPrefix={`${prefix}round:${round.number}:`}
            activeId={activeId}
            canWrite={canWrite}
            historical={historical}
            saving={controller.saving}
            onActive={onActive}
            focusRequest={focusRequest}
            onReturnToCanvas={onReturnToCanvas}
            act={controller.act}
            onReanchor={onReanchor}
          />
        ) : (
          <ReviewRoundDecision
            round={round}
            ownerUserId={view.review.task.ownerUserId}
            canWrite={canWrite && !historical}
            saving={controller.saving}
            draftKey={`${prefix}round:${round.number}:decision`}
            act={controller.act}
          />
        )}
      </div>
    </aside>
  );
}
