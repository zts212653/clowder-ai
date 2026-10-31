import type { QuoteContextAttachment } from '@cat-cafe/shared';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { SelectionAnnotationAction } from '@/components/SelectionAnnotationAction';
import { useShellCopy } from '@/components/shell/shell-copy';
import type { FloatingSelectionPosition } from '@/components/workspace/selection-action-position';
import { editWorkspaceFileQuoteInChat } from '@/components/workspace/workspace-file-quote';
import { workspaceFileQuotesCopy } from './workspace-file-quotes.shell-copy';

export type PendingFileQuote = { attachment: QuoteContextAttachment; number: number };

/** A group is a choice of actual draft ids, never permission to silently pick its first quote. */
export function WorkspacePendingFileQuoteEditor({
  threadId,
  quotes,
  position,
  onClose,
}: {
  threadId: string;
  quotes: readonly PendingFileQuote[];
  position: FloatingSelectionPosition;
  onClose: () => void;
}) {
  const [selectedId, setSelectedId] = useState(quotes.length === 1 ? quotes[0].attachment.id : null);
  const choices = useRef<HTMLElement>(null);
  const t = useShellCopy(workspaceFileQuotesCopy);
  useEffect(() => {
    if (!selectedId) choices.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [selectedId]);
  if (quotes.length === 0) return null;
  const selected = quotes.find(({ attachment }) => attachment.id === selectedId);
  if (selected) {
    return (
      <SelectionAnnotationAction
        key={selected.attachment.id}
        selectedText={selected.attachment.text}
        initialComment={selected.attachment.comment}
        initialEditing
        position={position}
        positionMode="fixed"
        actionTestId="workspace-pending-file-quote-editor"
        onSave={(comment) => editWorkspaceFileQuoteInChat(threadId, selected.attachment, comment)}
        onDelete={() => {
          editWorkspaceFileQuoteInChat(threadId, selected.attachment, null);
        }}
        onClose={onClose}
      />
    );
  }
  // An attachment removed elsewhere must close its editor, rather than select another id in its place.
  if (selectedId) return null;
  const top = Math.max(8, Math.min(position.top, window.innerHeight - 240));
  const width = Math.min(400, window.innerWidth - 16);
  const left = Math.max(8, Math.min(position.left, window.innerWidth - width - 8));
  return createPortal(
    <section
      ref={choices}
      role="dialog"
      aria-label={t.choosePending(quotes.length)}
      data-context-annotation-ui
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
      className="fixed z-[80] overflow-y-auto rounded-2xl border border-cafe bg-cafe-surface-elevated p-3 shadow-2xl"
      style={{ top, left, width, maxHeight: window.innerHeight - top - 8 }}
    >
      <p className="mb-2 text-xs text-cafe-secondary">{t.choosePending(quotes.length)}</p>
      {quotes.map(({ attachment, number }) => (
        <button
          key={attachment.id}
          type="button"
          aria-label={t.edit(number)}
          onClick={() => setSelectedId(attachment.id)}
          className="mb-2 block w-full rounded-xl border border-cafe-subtle p-2 text-left hover:bg-cafe-surface-sunken focus-visible:ring-2 focus-visible:ring-cafe-accent"
        >
          <span className="text-xs font-medium text-cafe-primary">{t.place(number)}</span>
          <span className="block line-clamp-2 whitespace-pre-wrap break-words text-xs text-cafe-secondary">
            {attachment.text}
          </span>
          <span className="block line-clamp-2 whitespace-pre-wrap break-words text-xs text-cafe-muted">
            {attachment.comment}
          </span>
        </button>
      ))}
      <button type="button" onClick={onClose} className="rounded-full border border-cafe px-3 py-1 text-xs">
        {t.closePending}
      </button>
    </section>,
    document.body,
  );
}
