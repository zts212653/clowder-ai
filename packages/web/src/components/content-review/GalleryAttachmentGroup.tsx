'use client';
import type { MediaContextAttachment } from '@cat-cafe/shared';
import { useShellLanguage } from '@/components/shell/shell-language';
import { ContextMediaSelections } from '../ContextMediaSelections';
import styles from './artwork-gallery.module.css';
import { MediaAttachmentThumbnail } from './MediaAttachmentThumbnail';
import { useGalleryAttachmentOpen } from './useGalleryAttachmentOpen';

export function GalleryAttachmentGroup({
  attachments,
  compact = false,
  onRemove,
  message,
  fromComposer = false,
}: {
  attachments: readonly MediaContextAttachment[];
  compact?: boolean;
  message?: { threadId: string; messageId: string };
  fromComposer?: boolean;
  onRemove?: (id: string) => void;
}) {
  const english = useShellLanguage() === 'en';
  const opening = useGalleryAttachmentOpen(attachments, message, fromComposer);
  const allImages = attachments.every((item) => item.mediaType !== 'video/mp4');
  const places = attachments.reduce((count, item) => count + item.selections.length, 0);
  const name = (attachment: MediaContextAttachment) =>
    attachment.gallery ? `${english ? 'Artwork' : '图'} ${attachment.gallery.index + 1}` : attachment.title;
  return (
    <section
      data-testid={compact ? 'gallery-composer-group' : 'gallery-message-group'}
      data-gallery-input={compact || undefined}
      className={`min-w-0 ${compact ? styles.compact : 'w-full max-w-xl overflow-hidden rounded-xl border border-cafe-subtle bg-cafe-surface-elevated'}`}
    >
      {!compact ? (
        <p className="px-3 pt-3 text-xs text-cafe-muted">
          {english
            ? `${attachments.length} artworks · ${places} places`
            : `${attachments.length} ${allImages ? '张图' : '件作品'} · ${places} 处`}
        </p>
      ) : null}
      <div
        className={compact ? styles.rows : 'divide-y divide-cafe-subtle'}
        role="region"
        aria-label={english ? 'Selected artwork places' : '已圈选作品'}
        tabIndex={compact ? 0 : undefined}
      >
        {attachments.map((attachment) => (
          <div
            key={attachment.id}
            data-testid="gallery-work-card"
            data-context-kind="media"
            data-attachment-id={attachment.id}
            className={compact ? styles.row : 'flex min-w-0 flex-wrap items-start gap-3 p-3'}
          >
            {!compact ? (
              <button
                type="button"
                disabled={opening.busy}
                onClick={() => void opening.open(attachment)}
                aria-label={english ? `Open ${name(attachment).toLowerCase()}` : `打开${name(attachment)}`}
                className="block min-w-0 w-32 shrink-0 text-left"
              >
                <MediaAttachmentThumbnail attachment={attachment} />
              </button>
            ) : null}
            {compact ? (
              <span className={styles.thumbnail}>
                <MediaAttachmentThumbnail attachment={attachment} compact />
              </span>
            ) : null}
            <div className={compact ? styles.details : 'min-w-0 flex-[1_1_12rem] space-y-2'}>
              {!compact ? (
                <button
                  type="button"
                  disabled={opening.busy}
                  onClick={() => void opening.open(attachment)}
                  className="block max-w-full break-words text-left text-xs font-medium text-cafe-secondary"
                >
                  {name(attachment)} · {attachment.title}
                </button>
              ) : (
                <span className={styles.name} title={attachment.title}>
                  {name(attachment)}
                </span>
              )}
              {attachment.selections.length ? (
                <ContextMediaSelections
                  attachment={attachment}
                  compact={compact}
                  removable={!!onRemove}
                  onOpen={(id) => void opening.open(attachment, id)}
                  opening={opening.busy}
                />
              ) : compact ? (
                <button
                  type="button"
                  disabled={opening.busy}
                  className="text-xs text-cafe-accent"
                  onClick={() => void opening.open(attachment)}
                >
                  {english ? 'Whole artwork' : '整件作品'}
                </button>
              ) : null}
            </div>
            {onRemove ? (
              <button
                type="button"
                aria-label={english ? `Remove ${attachment.title}` : `移除上下文 ${attachment.title}`}
                onClick={() => onRemove(attachment.id)}
                className="shrink-0 self-start rounded px-1 text-cafe-muted"
              >
                ×
              </button>
            ) : null}
          </div>
        ))}
      </div>
      {opening.error ? (
        <p role="alert" className="text-xs text-cafe-secondary">
          {opening.error}
        </p>
      ) : null}
    </section>
  );
}
