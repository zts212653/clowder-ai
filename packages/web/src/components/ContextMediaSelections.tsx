'use client';

import type { MediaContextAttachment } from '@cat-cafe/shared';
import { useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { AppTooltip } from './AppTooltip';
import { MediaAttachmentThumbnail } from './content-review/MediaAttachmentThumbnail';
import { removeMediaSelectionFromChat } from './content-review/media-chat-composer';
import { mediaSelectionLabel } from './content-review/media-chat-selection';
import styles from './content-review/media-selection-preview.module.css';
import {
  selectionPreviewSeconds,
  selectionPreviewTime,
  useMediaAttachmentPreview,
} from './content-review/useMediaAttachmentPreview';
import { useShellLanguage } from './shell/shell-language';

function StoryQuote({
  selection,
  english,
}: {
  selection: MediaContextAttachment['selections'][number]['selection'];
  english: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  if (selection.kind !== 'video-range' || !selection.storyEvidence) return null;
  return (
    <span className="min-w-0">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className="text-cafe-accent"
      >
        {english ? 'Quoted paragraph' : '段落原文'}
      </button>
      {expanded ? <span className="block whitespace-pre-wrap break-words">{selection.storyEvidence.quote}</span> : null}
    </span>
  );
}

/**
 * The places a person circled, as numbered tags. A gallery keeps its stable cross-work ids; a legacy single work
 * displays its local attachment order, matching its canvas marks. A place is named
 * by what the person did there (圈选 / 点选), never by coordinates. Only a composer chip, which can be removed at
 * all, offers a per-place remove.
 */
export function ContextMediaSelections({
  attachment,
  compact,
  removable,
  onOpen,
  opening = false,
}: {
  attachment: MediaContextAttachment;
  compact: boolean;
  removable: boolean;
  onOpen?: (selectionId: string) => void;
  opening?: boolean;
}) {
  const english = useShellLanguage() === 'en';
  const media = useMediaAttachmentPreview(attachment);
  if (attachment.selections.length === 0) return null;
  return (
    <span data-testid="media-selections" className={`${styles.places} ${compact ? styles.compact : ''}`}>
      {attachment.selections.map((item, index) => {
        const seconds = selectionPreviewSeconds(item.selection, media);
        const tooltip = `${seconds === null ? '' : `${selectionPreviewTime(seconds)} · `}${attachment.title}`;
        const words = item.instruction || (english ? 'Selected place' : mediaSelectionLabel(item));
        return (
          <span key={item.id} data-selection-id={item.id} className={styles.place}>
            <span className={styles.chip}>
              <AppTooltip
                label={tooltip}
                side="top"
                intent="content"
                multiline
                detail={
                  <span className={styles.hover}>
                    <MediaAttachmentThumbnail attachment={attachment} item={item} media={media} expanded />
                    <span className="block whitespace-pre-wrap">{item.instruction}</span>
                  </span>
                }
              >
                <button
                  type="button"
                  disabled={opening}
                  onClick={() => onOpen?.(item.id)}
                  aria-label={
                    english
                      ? `Open artwork ${(attachment.gallery?.index ?? 0) + 1} · Place ${item.id}`
                      : `打开图 ${(attachment.gallery?.index ?? 0) + 1} · 第 ${item.id} 处`
                  }
                  className={styles.open}
                >
                  <MediaAttachmentThumbnail attachment={attachment} item={item} media={media} compact />
                  <span data-testid="media-selection-number" className={styles.number}>
                    {attachment.gallery ? item.id : index + 1}
                  </span>
                  <span className={styles.words}>
                    {Array.from(words).slice(0, 16).join('')}
                    {Array.from(words).length > 16 ? '…' : ''}
                  </span>
                </button>
              </AppTooltip>
              {removable ? (
                <button
                  type="button"
                  aria-label={
                    english
                      ? `Remove selection ${attachment.gallery ? item.id : index + 1}`
                      : `移除选区 ${attachment.gallery ? item.id : index + 1}`
                  }
                  onClick={() => {
                    const threadId = useChatStore.getState().currentThreadId;
                    if (threadId) removeMediaSelectionFromChat(threadId, attachment.id, item.id);
                  }}
                  className={styles.remove}
                >
                  <svg className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                    <path d="m5.7 4.3 4.3 4.3 4.3-4.3 1.4 1.4-4.3 4.3 4.3 4.3-1.4 1.4-4.3-4.3-4.3 4.3-1.4-1.4L8.6 10 4.3 5.7l1.4-1.4Z" />
                  </svg>
                </button>
              ) : null}
            </span>
            <StoryQuote selection={item.selection} english={english} />
          </span>
        );
      })}
    </span>
  );
}
