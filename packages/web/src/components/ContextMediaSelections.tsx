'use client';

import type { MediaContextAttachment } from '@cat-cafe/shared';
import { useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { removeMediaSelectionFromChat } from './content-review/media-chat-composer';
import { mediaSelectionLabel } from './content-review/media-chat-selection';
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
  const compactWords = attachment.gallery ? 'max-w-24 truncate' : 'max-w-48 truncate';
  if (attachment.selections.length === 0) return null;
  return (
    <span
      data-testid="media-selections"
      className={`flex min-w-0 gap-1 ${compact && attachment.gallery ? 'flex-nowrap overflow-x-auto' : compact ? 'mt-1 flex-wrap' : 'mt-1 flex-col'} text-micro text-cafe-secondary`}
    >
      {attachment.selections.map((item, index) => (
        <span
          key={item.id}
          data-selection-id={item.id}
          title={compact ? item.instruction : undefined}
          className={`flex min-w-0 items-center gap-1 ${compact ? 'shrink-0 rounded-full border border-cafe-subtle px-1.5 py-0.5' : ''}`}
        >
          {onOpen ? (
            <button
              type="button"
              disabled={opening}
              onClick={() => onOpen(item.id)}
              aria-label={
                english
                  ? `Open artwork ${(attachment.gallery?.index ?? 0) + 1} · Place ${item.id}`
                  : `打开图 ${(attachment.gallery?.index ?? 0) + 1} · 第 ${item.id} 处`
              }
              className={`flex min-w-0 gap-1 rounded text-left text-cafe hover:bg-cafe-surface-sunken ${compact ? 'items-center' : 'items-start'}`}
            >
              <span
                data-testid="media-selection-number"
                className="shrink-0 rounded-full border border-cafe-subtle px-1 font-semibold"
              >
                {item.id}
              </span>
              {compact && !attachment.gallery ? (
                <span className="shrink-0">{english ? 'Artwork 1' : '图 1'}</span>
              ) : null}
              <span className={`min-w-0 text-xs ${compact ? compactWords : 'whitespace-pre-wrap break-words'}`}>
                {item.instruction || (english ? 'Selected place' : mediaSelectionLabel(item))}
              </span>
            </button>
          ) : (
            <>
              <span
                data-testid="media-selection-number"
                className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-cafe-subtle bg-cafe-surface-sunken font-semibold"
              >
                {attachment.gallery ? item.id : index + 1}
              </span>
              <span className="shrink-0">{mediaSelectionLabel(item)}</span>
              {attachment.gallery ? (
                <span className="shrink-0 text-cafe-muted">图 {attachment.gallery.index + 1}</span>
              ) : null}
              {(!compact || attachment.gallery) && item.instruction ? (
                <span className={`min-w-0 text-xs text-cafe ${compact ? compactWords : 'whitespace-pre-wrap'}`}>
                  {item.instruction}
                </span>
              ) : null}
            </>
          )}
          <StoryQuote selection={item.selection} english={english} />
          {removable ? (
            <button
              type="button"
              aria-label={`移除选区 ${attachment.gallery ? item.id : index + 1}`}
              onClick={() => {
                const threadId = useChatStore.getState().currentThreadId;
                if (threadId) removeMediaSelectionFromChat(threadId, attachment.id, item.id);
              }}
              className="shrink-0 rounded p-0.5 text-cafe-muted hover:bg-cafe-surface-sunken hover:text-cafe-secondary"
            >
              <svg className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path d="m5.7 4.3 4.3 4.3 4.3-4.3 1.4 1.4-4.3 4.3 4.3 4.3-1.4 1.4-4.3-4.3-4.3 4.3-1.4-1.4L8.6 10 4.3 5.7l1.4-1.4Z" />
              </svg>
            </button>
          ) : null}
        </span>
      ))}
    </span>
  );
}
