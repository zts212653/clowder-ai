'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { LongFormReaderDialog, type ReaderSource } from './LongFormReaderDialog';
import { useMeasuredOverflow } from './useMeasuredOverflow';

interface LongFormReaderProps {
  title: string;
  summary: string;
  accessibleSummary?: string;
  content: string;
  format?: 'markdown' | 'plaintext';
  source?: ReaderSource;
  className?: string;
  summaryClassName?: string;
  density?: 'default' | 'compact';
  triggerAriaLabel?: string;
  onOpenChange?: (open: boolean) => void;
}

export function LongFormReader({
  title,
  summary,
  accessibleSummary,
  content,
  format = 'plaintext',
  source,
  className = '',
  summaryClassName,
  density = 'default',
  triggerAriaLabel,
  onOpenChange,
}: LongFormReaderProps) {
  const summaryId = useId();
  const dialogId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [readerLatched, setReaderLatched] = useState(false);
  const { ref, overflowing } = useMeasuredOverflow<HTMLParagraphElement>({
    axis: 'block',
  });
  const hasDistinctFullContent = summary.trim() !== content.trim();
  const readerAvailable = hasDistinctFullContent || overflowing || readerLatched;
  const compact = density === 'compact';
  const resolvedSummaryClassName =
    summaryClassName ?? `text-sm text-cafe-secondary ${compact ? 'leading-5' : 'leading-6'}`;
  const showBoundedAccessibleSummary = readerAvailable && Boolean(accessibleSummary?.trim());

  const close = useCallback(() => {
    restoreFocusRef.current = true;
    setOpen(false);
    onOpenChange?.(false);
  }, [onOpenChange]);

  useEffect(() => {
    if (!open && restoreFocusRef.current) {
      restoreFocusRef.current = false;
      triggerRef.current?.focus();
    }
  }, [open]);

  return (
    <div className={className}>
      <p
        id={showBoundedAccessibleSummary ? undefined : summaryId}
        ref={ref}
        aria-hidden={showBoundedAccessibleSummary ? true : undefined}
        data-overflow-measure="block"
        className={`overflow-hidden ${resolvedSummaryClassName}`}
        style={{
          display: '-webkit-box',
          WebkitBoxOrient: 'vertical',
          WebkitLineClamp: compact ? 2 : 3,
        }}
      >
        {summary}
      </p>
      {showBoundedAccessibleSummary && (
        <span id={summaryId} className="sr-only">
          {accessibleSummary}
        </span>
      )}
      {readerAvailable && (
        <button
          ref={triggerRef}
          type="button"
          aria-haspopup="dialog"
          aria-describedby={summaryId}
          aria-label={triggerAriaLabel}
          aria-expanded={open}
          aria-controls={dialogId}
          onClick={(event) => {
            event.stopPropagation();
            setReaderLatched(true);
            setOpen(true);
            onOpenChange?.(true);
          }}
          onKeyDown={(event) => event.stopPropagation()}
          className={
            compact
              ? 'mt-1 inline-flex rounded-md px-1.5 py-0.5 text-xs font-semibold text-cafe-accent transition-colors hover:bg-cafe-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cafe-accent focus-visible:ring-offset-1'
              : 'mt-3 rounded-lg bg-cafe-accent px-3 py-2 text-xs font-semibold text-[var(--cafe-accent-foreground)] transition-colors hover:bg-cafe-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cafe-accent focus-visible:ring-offset-2'
          }
        >
          {compact ? '查看全文' : '阅读全文'}
        </button>
      )}
      {open && (
        <LongFormReaderDialog
          id={dialogId}
          title={title}
          content={content}
          format={format}
          source={source}
          onClose={close}
        />
      )}
    </div>
  );
}
