'use client';

import type { QuoteContextAttachment } from '@cat-cafe/shared';
import { useRef, useState } from 'react';
import { replyBodyCopy } from './reply-body.shell-copy';
import { useShellCopy } from './shell/shell-copy';

/** Explicit draft references keep their original IDs, order and text; the popover is only a reading view. */
export function ComposerFileQuoteTags({
  quotes,
  numbers,
  onRemove,
}: {
  quotes: readonly QuoteContextAttachment[];
  numbers: ReadonlyMap<string, number>;
  onRemove: (id: string) => void;
}) {
  const t = useShellCopy(replyBodyCopy);
  const [active, setActive] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const close = () => {
    setActive(null);
    if (trigger.current?.isConnected) trigger.current.focus({ preventScroll: true });
  };
  const selected = quotes.find((quote) => quote.id === active);
  return (
    <div className="relative flex w-full min-w-0 flex-wrap gap-1" data-testid="context-file-quote-tags">
      {quotes.map((quote) => {
        const number = numbers.get(quote.id);
        if (!number) return null;
        return (
          <span
            key={quote.id}
            className="inline-flex min-w-0 items-center rounded-full border border-cafe-subtle bg-cafe-surface-elevated text-xs"
          >
            <button
              type="button"
              data-testid="context-file-quote-tag"
              data-quote-id={quote.id}
              aria-expanded={active === quote.id}
              aria-label={t.place(number)}
              title={quote.text}
              onClick={(event) => {
                trigger.current = event.currentTarget;
                setActive(active === quote.id ? null : quote.id);
              }}
              className="flex min-w-0 items-center gap-1 rounded-full px-2 py-1"
            >
              <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-cafe-subtle">
                {number}
              </span>
              <span className="max-w-28 truncate">{quote.text.replace(/\s+/g, ' ').trim()}</span>
            </button>
            <button
              type="button"
              data-quote-remove={quote.id}
              aria-label={t.remove(t.place(number))}
              onClick={() => onRemove(quote.id)}
              className="rounded-full px-1.5 py-1"
            >
              ×
            </button>
          </span>
        );
      })}
      {selected ? (
        <article
          data-testid={`context-annotation-item-${selected.id}`}
          className="absolute bottom-full left-0 z-[75] mb-2 max-h-64 w-[28rem] max-w-full overflow-auto rounded-xl border border-cafe-subtle bg-cafe-surface-elevated p-3 text-sm shadow-xl"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              close();
            }
          }}
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <strong className="text-xs">{t.place(numbers.get(selected.id) ?? 1)}</strong>
            <button
              type="button"
              data-testid="context-file-quote-close"
              className="rounded border border-cafe-subtle px-2 py-1 text-xs"
              onClick={close}
            >
              {t.showLess}
            </button>
          </div>
          <blockquote className="whitespace-pre-wrap break-words">{selected.text}</blockquote>
          {selected.source.kind === 'workspace_file' && !selected.source.revision ? (
            <p className="mt-1 text-xs text-cafe-muted">{t.unversionedFileQuote}</p>
          ) : null}
          {selected.comment ? (
            <div className="mt-2 border-t border-cafe-subtle pt-2">
              <span className="text-xs text-cafe-muted">{t.comment}</span>
              <p className="whitespace-pre-wrap break-words">{selected.comment}</p>
            </div>
          ) : null}
        </article>
      ) : null}
    </div>
  );
}
