'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useMeasuredOverflow } from './useMeasuredOverflow';

interface CompactLabelProps {
  label: string;
  value: string;
  className?: string;
  density?: 'default' | 'compact';
}

export function CompactLabel({ label, value, className = '', density = 'default' }: CompactLabelProps) {
  const tooltipId = useId();
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  const [copied, setCopied] = useState(false);
  const { ref, overflowing } = useMeasuredOverflow<HTMLSpanElement>({
    axis: 'inline',
  });

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  }, [value]);

  return (
    <div className={`group relative flex min-w-0 items-center gap-2 ${className}`}>
      <span
        ref={ref}
        data-overflow-measure="inline"
        className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap"
      >
        {value}
      </span>

      {overflowing && (
        <>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              void copy();
            }}
            onKeyDown={(event) => event.stopPropagation()}
            aria-label={copied ? `已复制完整${label}` : `复制完整${label}`}
            aria-describedby={tooltipId}
            className={
              density === 'compact'
                ? 'flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-cafe-muted transition-colors hover:bg-cafe-surface hover:text-cafe-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cafe-accent'
                : 'shrink-0 rounded-md border border-cafe px-2 py-1 text-xs font-semibold text-cafe-secondary transition-colors hover:border-cafe-accent hover:text-cafe-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cafe-accent'
            }
          >
            {density === 'compact' ? (
              <>
                <span className="sr-only" aria-live="polite">
                  {copied ? '已复制' : '复制全文'}
                </span>
                <CopyStatusIcon copied={copied} />
              </>
            ) : copied ? (
              '已复制'
            ) : (
              '复制全文'
            )}
          </button>
          <span
            id={tooltipId}
            role="tooltip"
            className="invisible absolute top-full left-0 z-50 mt-2 max-w-[min(32rem,calc(100vw-2rem))] rounded-lg border border-cafe bg-cafe-surface-elevated px-3 py-2 text-xs leading-5 break-all whitespace-normal text-cafe-secondary opacity-0 shadow-lg transition group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100"
          >
            {value}
          </span>
        </>
      )}
    </div>
  );
}

function CopyStatusIcon({ copied }: { copied: boolean }) {
  return copied ? (
    <svg aria-hidden="true" className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
      <path
        fillRule="evenodd"
        d="M16.704 5.29a1 1 0 010 1.414l-7.5 7.5a1 1 0 01-1.414 0l-3.5-3.5a1 1 0 011.414-1.414l2.793 2.793 6.793-6.793a1 1 0 011.414 0z"
        clipRule="evenodd"
      />
    </svg>
  ) : (
    <svg
      aria-hidden="true"
      className="h-3.5 w-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}
