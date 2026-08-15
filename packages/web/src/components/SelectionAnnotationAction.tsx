'use client';

import { CONTEXT_ATTACHMENT_COMMENT_MAX_LENGTH } from '@cat-cafe/shared';
import { type CSSProperties, type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useIMEGuard } from '@/hooks/useIMEGuard';
import type { FloatingSelectionPosition } from './workspace/selection-action-position';

interface SelectionAnnotationActionProps {
  selectedText: string;
  position: FloatingSelectionPosition;
  positionMode: 'fixed' | 'absolute';
  actionTestId: string;
  onSave: (comment: string) => void;
  /** F294: optional cross-thread path. Unlike Add to chat, Comment may be empty. */
  onForward?: (comment: string) => void;
  initialComment?: string;
  triggerContent?: ReactNode;
  triggerClassName?: string;
  onDelete?: () => void;
  onOpen?: () => void;
  onClose?: () => void;
}

function annotationEditorPosition(
  position: FloatingSelectionPosition,
  positionMode: 'fixed' | 'absolute',
): CSSProperties {
  if (positionMode === 'fixed' && typeof window !== 'undefined') {
    const viewportGutter = 8;
    const width = Math.min(400, window.innerWidth - 16);
    const top = Math.max(viewportGutter, Math.min(position.top, window.innerHeight - 160));
    return {
      top,
      left: Math.max(viewportGutter, Math.min(position.left, window.innerWidth - width - viewportGutter)),
      maxHeight: Math.max(0, window.innerHeight - top - viewportGutter),
    };
  }
  const top = Math.max(8, position.top);
  return {
    top,
    left: Math.max(8, position.left - 288),
    maxHeight: `calc(100% - ${top + 8}px)`,
  };
}

function renderSelectionSurface(surface: ReactNode, positionMode: 'fixed' | 'absolute'): ReactNode {
  if (positionMode === 'fixed' && typeof document !== 'undefined') return createPortal(surface, document.body);
  return surface;
}

export function SelectionAnnotationAction({
  selectedText,
  position,
  positionMode,
  actionTestId,
  onSave,
  onForward,
  initialComment = '',
  triggerContent,
  triggerClassName,
  onDelete,
  onOpen,
  onClose,
}: SelectionAnnotationActionProps) {
  const [editing, setEditing] = useState(false);
  const [comment, setComment] = useState(initialComment);
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const commentId = useId();
  const commentHintId = `${commentId}-hint`;
  const ime = useIMEGuard();

  useEffect(() => {
    void selectedText;
    setEditing(false);
    setComment(initialComment);
  }, [initialComment, selectedText]);

  useLayoutEffect(() => {
    if (editing) commentRef.current?.focus();
  }, [editing]);

  const positionClass = positionMode === 'fixed' ? 'fixed' : 'absolute';

  if (!editing) {
    return renderSelectionSurface(
      <button
        type="button"
        data-testid={actionTestId}
        data-context-annotation-ui
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          onOpen?.();
          setEditing(true);
        }}
        style={position}
        className={
          triggerClassName ??
          `${positionClass} z-[70] flex items-center gap-1.5 rounded-lg bg-cafe-accent px-2.5 py-1.5 text-xs font-medium text-[var(--cafe-surface)] shadow-lg transition-colors hover:bg-cafe-interactive`
        }
        title="引用到聊天"
      >
        {triggerContent ?? (
          <>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M1.5 2.5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1H5L2.5 11.5V9h-1a1 1 0 0 1-1-1V2.5Z" />
              <path d="M13.5 5v4a1 1 0 0 1-1 1H12v2.5L9.5 10H7a1 1 0 0 1-1-1" opacity="0.5" />
            </svg>
            Add to chat
          </>
        )}
      </button>,
      positionMode,
    );
  }

  const save = () => {
    const trimmed = comment.trim();
    if (!trimmed) return;
    onSave(trimmed);
    setEditing(false);
    setComment(initialComment);
    onClose?.();
  };

  const forward = () => {
    if (!onForward) return;
    onForward(comment.trim());
    setEditing(false);
    onClose?.();
  };

  return renderSelectionSurface(
    <section
      data-testid="context-annotation-editor"
      data-context-annotation-ui
      style={annotationEditorPosition(position, positionMode)}
      className={`${positionClass} z-[80] flex max-h-[calc(100dvh-1rem)] w-[min(25rem,calc(100vw-1rem))] flex-col overflow-hidden rounded-2xl border border-cafe bg-cafe-surface-elevated shadow-2xl`}
      aria-label="添加选区批注"
    >
      <div data-testid="context-annotation-scroll-region" className="min-h-0 overflow-y-auto">
        <div className="border-b border-cafe-subtle px-4 py-3">
          <div className="mb-1 text-micro font-semibold uppercase tracking-[0.14em] text-cafe-muted">Selected text</div>
          <blockquote className="line-clamp-5 whitespace-pre-wrap text-sm leading-relaxed text-cafe-secondary">
            {selectedText}
          </blockquote>
        </div>
        <div className="px-4 py-3">
          <label htmlFor={commentId} className="mb-1.5 block text-xs font-medium text-cafe-muted">
            User comment
          </label>
          <textarea
            id={commentId}
            ref={commentRef}
            data-testid="context-annotation-comment"
            aria-describedby={commentHintId}
            value={comment}
            maxLength={CONTEXT_ATTACHMENT_COMMENT_MAX_LENGTH}
            onChange={(event) => setComment(event.target.value)}
            onCompositionStart={ime.onCompositionStart}
            onCompositionEnd={ime.onCompositionEnd}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !ime.isComposing()) {
                event.preventDefault();
                save();
                return;
              }
              if (event.key === 'Escape') {
                setEditing(false);
                setComment(initialComment);
                onClose?.();
              }
            }}
            rows={3}
            placeholder="写下你对这段内容的点评…"
            className="w-full resize-none rounded-xl border border-cafe-subtle bg-cafe-surface px-3 py-2 text-sm text-cafe-primary outline-none transition focus:border-cafe-accent focus:ring-2 focus:ring-cafe-accent/20"
          />
          <p id={commentHintId} className="mt-1.5 text-micro text-cafe-muted">
            Enter 保存 · Shift+Enter 换行
          </p>
        </div>
      </div>
      <div
        data-testid="context-annotation-actions"
        className="flex shrink-0 items-center gap-2 border-t border-cafe-subtle bg-cafe-surface-elevated px-4 py-3"
      >
        {onDelete && (
          <button
            type="button"
            aria-label="删除批注"
            onClick={() => {
              onDelete();
              setEditing(false);
              onClose?.();
            }}
            className="mr-auto rounded-full p-2 text-cafe-muted hover:bg-cafe-surface-sunken hover:text-conn-red-text"
          >
            <svg
              className="h-4 w-4"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <path
                d="M3.5 5.5h13M8 8.5v5M12 8.5v5M6 5.5l.7 10h6.6l.7-10M8 5.5V3.8h4v1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            setEditing(false);
            setComment(initialComment);
            onClose?.();
          }}
          className="rounded-full border border-cafe px-3.5 py-1.5 text-xs font-medium text-cafe-secondary hover:bg-cafe-surface-sunken"
        >
          Cancel
        </button>
        {onForward ? (
          <button
            type="button"
            data-testid="context-annotation-forward"
            onClick={forward}
            className="rounded-full border border-cafe px-3.5 py-1.5 text-xs font-semibold text-cafe-secondary hover:bg-cafe-surface-sunken"
          >
            转发…
          </button>
        ) : null}
        <button
          type="button"
          data-testid="context-annotation-save"
          disabled={!comment.trim()}
          onClick={save}
          className="rounded-full bg-cafe-accent px-3.5 py-1.5 text-xs font-semibold text-[var(--cafe-surface)] hover:bg-cafe-interactive disabled:cursor-not-allowed disabled:opacity-40"
        >
          加入当前聊天
        </button>
      </div>
    </section>,
    positionMode,
  );
}
