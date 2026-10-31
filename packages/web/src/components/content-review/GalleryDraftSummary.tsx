'use client';
import type { ContextAttachment } from '@cat-cafe/shared';
import { useShellLanguage } from '@/components/shell/shell-language';
import styles from './artwork-gallery.module.css';

export function GalleryDraftSummary({ attachments }: { attachments: readonly ContextAttachment[] }) {
  const english = useShellLanguage() === 'en';
  const works = attachments.filter((item) => item.kind === 'media' && item.gallery);
  if (!works.length) return null;
  const places = works.reduce((count, item) => count + (item.kind === 'media' ? item.selections.length : 0), 0);
  const allImages = works.every((item) => item.kind === 'media' && item.mediaType !== 'video/mp4');
  return (
    <span data-testid="gallery-draft-summary" className={styles.summary}>
      <span className={styles.shortSummary}>{english ? `${places} places · Send` : `${places} 处 · 发送`}</span>
      <span className={styles.fullSummary}>
        {english
          ? `${works.length} artworks · ${places} places · Send to this chat`
          : `${works.length} ${allImages ? '张图' : '件作品'} · ${places} 处 · 发到这条对话`}
      </span>
    </span>
  );
}
