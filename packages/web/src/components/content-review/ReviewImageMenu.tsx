'use client';
import { type ArtifactReviewImageEdit, REVIEW_IMAGE_RATIOS } from '@cat-cafe/shared';
import { useRef } from 'react';
import { ReviewToolbarIcon } from './ReviewToolbarIcon';
import styles from './review-toolbar.module.css';

const labels = { '1:1': '方形', '3:4': '竖版', '9:16': '故事版', '4:3': '横版', '16:9': '宽屏' };
export function ReviewImageMenu({
  disabled,
  onRequest,
}: {
  disabled: boolean;
  onRequest: (edit: ArtifactReviewImageEdit) => void;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  return (
    <details
      ref={menu}
      className={styles.toolMenu}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && menu.current) {
          menu.current.open = false;
          menu.current.querySelector('summary')?.focus();
        }
      }}
    >
      <summary
        className={styles.iconButton}
        aria-label="调整比例"
        title="调整比例"
        aria-disabled={disabled}
        onClick={(event) => {
          if (disabled) event.preventDefault();
        }}
      >
        <ReviewToolbarIcon name="resize" />
      </summary>
      <div className={`${styles.menu} ${styles.imageMenu}`}>
        <p className={styles.menuLabel}>交给原任务猫，生成新比例</p>
        {REVIEW_IMAGE_RATIOS.map((ratio) => (
          <button
            key={ratio}
            type="button"
            className={styles.menuChoice}
            disabled={disabled}
            aria-label={`让猫调整为 ${ratio}`}
            onClick={() => {
              if (disabled) return;
              if (menu.current) menu.current.open = false;
              onRequest({ kind: 'aspect-ratio', ratio });
            }}
          >
            <span className={styles.ratioIcon} style={{ aspectRatio: ratio.replace(':', '/') }} aria-hidden />
            <span>
              {labels[ratio]} <span className="text-cafe-muted">{ratio}</span>
            </span>
          </button>
        ))}
      </div>
    </details>
  );
}
