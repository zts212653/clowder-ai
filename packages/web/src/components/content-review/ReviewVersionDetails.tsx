import type { ReactNode } from 'react';
import { ReviewHistory } from './ReviewHistory';
import { ReviewToolbarIcon } from './ReviewToolbarIcon';
import toolbar from './review-toolbar.module.css';
import styles from './review-workspace.module.css';

export function ReviewVersionDetails({
  responseControl,
  reviewId,
  revision,
  ownerUserId,
  onClose,
  contextControl,
}: {
  responseControl?: ReactNode;
  reviewId: string;
  revision: number;
  ownerUserId: string;
  onClose: () => void;
  contextControl?: ReactNode;
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
        {contextControl}
        {responseControl}
        <ReviewHistory reviewId={reviewId} revision={revision} ownerUserId={ownerUserId} />
      </div>
    </aside>
  );
}
