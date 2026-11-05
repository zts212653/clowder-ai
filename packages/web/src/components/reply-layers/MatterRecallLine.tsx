'use client';

import type { MatterPage } from '@cat-cafe/shared';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { RecallEvent } from '@/hooks/recall-types';
import { apiFetch } from '@/utils/api-client';
import { RecallIcon } from '../memory/RecallRow';
import { MatterReadContent } from './MatterReadContent';

type Receipt = { status: 'current'; page: MatterPage } | { status: 'changed' | 'not_available' };

/** Only persisted, explicit, nonempty reads reach this line; listing a page never does. */
export function MatterRecallLine({ event, threadId }: { event: RecallEvent; threadId: string }) {
  const [open, setOpen] = useState(false);
  const [read, setRead] = useState<Receipt | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const summary = event.matterRead;
  const receiptIdentity = JSON.stringify([threadId, event.invocationId, event.catId, event.cueId, summary]);
  useEffect(() => {
    setRead(null);
    setOpen(false);
  }, [receiptIdentity]);
  useEffect(() => {
    if (!open || !event.invocationId || !event.cueId || !event.catId) return;
    let active = true;
    setRead(null);
    setFailed(false);
    const url = `/api/threads/${encodeURIComponent(threadId)}/invocations/${encodeURIComponent(event.invocationId)}/memory-cues/${encodeURIComponent(event.cueId)}/matter?catId=${encodeURIComponent(event.catId)}`;
    apiFetch(url, undefined, { afterCurrentGet: true })
      .then(async (response) => {
        if (!response.ok) throw new Error('read unavailable');
        const body = (await response.json()) as Receipt;
        if (active) setRead(body);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [open, event.invocationId, event.cueId, event.catId, threadId, attempt]);
  useEffect(() => {
    if (!open) return;
    const close = () => {
      setOpen(false);
      trigger.current?.focus();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    const outside = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node))
        setOpen(false);
    };
    const scroll = (event: Event) => {
      if (!(event.target instanceof Node) || !panel.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('keydown', key);
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', scroll, true);
    panel.current?.focus();
    return () => {
      document.removeEventListener('keydown', key);
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', scroll, true);
    };
  }, [open]);
  if (!summary || event.source !== 'pull' || event.cueStatus !== 'drilled') return null;
  const status = read?.status ?? summary.status;
  const label =
    status === 'changed'
      ? '参考资料已更正'
      : status === 'not_available'
        ? '参考资料已不可用'
        : summary.status === 'current'
          ? `参考了「${summary.title}」的 ${summary.messageCount} 条消息`
          : '参考资料';
  const rect = trigger.current?.getBoundingClientRect();
  const width = typeof window === 'undefined' ? 0 : Math.min(760, window.innerWidth - 24);
  const top = rect ? Math.max(12, Math.min(rect.bottom + 6, window.innerHeight - 200)) : 12;
  const matterId = summary.status !== 'not_available' ? summary.matterId : undefined;
  return (
    <div className="relative mb-3 text-sm" data-testid="matter-recall-line">
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(!open)}
        className="shell-focusable inline-flex items-start gap-2 text-left text-cafe-muted hover:text-cafe"
      >
        <span aria-hidden="true" className="mt-0.5">
          <RecallIcon kind="read" />
        </span>
        {label}
      </button>
      {open &&
        rect &&
        createPortal(
          <div
            ref={panel}
            role="dialog"
            aria-label="参考消息"
            tabIndex={-1}
            className="z-[70] overflow-y-auto rounded-xl border border-cafe-subtle bg-[var(--shell-paper)] p-4 text-cafe shadow-lg outline-none"
            style={{
              position: 'fixed',
              width,
              left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
              top,
              maxHeight: window.innerHeight - top - 12,
            }}
          >
            {!read && !failed && (
              <p role="status" className="text-sm text-cafe-muted">
                正在读取…
              </p>
            )}
            {failed && (
              <p role="alert" className="text-sm text-cafe-muted">
                暂时无法读取{' '}
                <button
                  type="button"
                  className="text-cafe-accent underline"
                  onClick={() => setAttempt((value) => value + 1)}
                >
                  重试
                </button>
              </p>
            )}
            {read?.status === 'current' && <MatterReadContent page={read.page} />}
            {read?.status === 'changed' && <p className="text-sm text-cafe-muted">来源已更正</p>}
            {read?.status === 'not_available' && <p className="text-sm text-cafe-muted">来源已不可用</p>}
            {matterId && read?.status !== 'not_available' && (
              <div className="mt-3 text-right">
                <Link
                  className="shell-focusable text-sm text-cafe-muted hover:underline"
                  href={`/memory?matter=${encodeURIComponent(matterId)}&from=${encodeURIComponent(threadId)}`}
                >
                  查看全部 ›
                </Link>
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
