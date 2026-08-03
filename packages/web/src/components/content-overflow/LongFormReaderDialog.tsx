'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MarkdownContent } from '@/components/MarkdownContent';
import { countReaderMatches, highlightReaderText } from './readerSearch';

export interface ReaderSource {
  label: string;
  href: string;
}

interface LongFormReaderDialogProps {
  id: string;
  title: string;
  content: string;
  format: 'markdown' | 'plaintext';
  source?: ReaderSource;
  onClose: () => void;
}

function focusableElements(panel: HTMLElement): HTMLElement[] {
  return Array.from(
    panel.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), [tabindex="0"]'),
  );
}

function trapTabKey(event: KeyboardEvent, panel: HTMLElement) {
  if (event.key !== 'Tab') return;

  const focusable = focusableElements(panel);
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
    return;
  }
  if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export function LongFormReaderDialog({ id, title, content, format, source, onClose }: LongFormReaderDialogProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [copied, setCopied] = useState(false);
  const matchCount = countReaderMatches(content, query);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }, [content]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    searchRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (panelRef.current) trapTabKey(event, panelRef.current);
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop dismissal is supplemental; Escape and the close button are the keyboard path.
    <div
      role="presentation"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--console-overlay-backdrop)] p-3 backdrop-blur-sm sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        id={id}
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[calc(100dvh-24px)] w-full max-w-3xl min-w-0 flex-col overflow-x-hidden rounded-2xl border border-cafe bg-[var(--console-card-bg)] shadow-2xl sm:max-h-[calc(100dvh-48px)]"
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-cafe px-4 py-4 sm:px-6">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-cafe-muted">长文阅读面</p>
            <h2 id={titleId} className="mt-1 break-words text-lg font-bold text-cafe">
              {title}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭阅读面"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-cafe-muted transition-colors hover:bg-[var(--console-modal-close-bg)] hover:text-cafe focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cafe-accent"
          >
            ✕
          </button>
        </header>

        <div className="flex shrink-0 flex-col gap-3 border-b border-cafe px-4 py-3 sm:flex-row sm:items-center sm:px-6">
          <label className="min-w-0 flex-1">
            <span className="sr-only">在全文中搜索</span>
            <input
              ref={searchRef}
              type="search"
              value={query}
              onInput={(event) => setQuery(event.currentTarget.value)}
              placeholder="在全文中搜索"
              className="w-full rounded-lg border border-[var(--console-border-soft)] bg-[var(--console-field-bg,var(--console-card-bg))] px-3 py-2 text-sm text-cafe outline-none focus:border-cafe-accent focus:ring-1 focus:ring-cafe-accent"
            />
          </label>
          <div className="flex items-center gap-2">
            <span aria-live="polite" className="min-w-16 text-xs text-cafe-muted">
              {query.trim() ? `${matchCount} 处匹配` : '搜索全文'}
            </span>
            <button
              type="button"
              onClick={copy}
              aria-label="复制完整内容"
              className="rounded-lg border border-cafe px-3 py-2 text-xs font-semibold text-cafe-secondary transition-colors hover:border-cafe-accent hover:text-cafe-accent"
            >
              {copied ? '已复制' : '复制全文'}
            </button>
            {source && (
              <a
                href={source.href}
                className="rounded-lg border border-cafe px-3 py-2 text-xs font-semibold text-cafe-secondary transition-colors hover:border-cafe-accent hover:text-cafe-accent"
              >
                来源 · {source.label}
              </a>
            )}
          </div>
        </div>

        <article className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-5 sm:px-6">
          {format === 'markdown' ? (
            <MarkdownContent content={content} textProcessor={(children) => highlightReaderText(children, query)} />
          ) : (
            <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-6 text-cafe-secondary">
              {highlightReaderText(content, query)}
            </pre>
          )}
        </article>
      </div>
    </div>,
    document.body,
  );
}
