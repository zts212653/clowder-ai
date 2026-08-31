'use client';

/**
 * F257 Console 判据④ — True-scene replay modal for a segment observation.
 *
 * Loads `/api/segment-lifeline/:segmentId/replay` and presents the operator-facing
 * evidence coordinate: source thread/message plus captured conversation context.
 * Template/render internals stay in the durable replay snapshot for audit and
 * evaluation, but do not compete with the conversation in this primary surface.
 */

import type { SegmentReplayResponse } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiFetch } from '@/utils/api-client';
import { SettingsBadge, SettingsText } from './primitives';

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface ReplayPanelProps {
  segmentId: string;
  threadId: string;
  turnId: string;
  catId: string;
  pipelineStatus: string;
  /** Controlled open state. */
  isOpen: boolean;
  /** Close callback (Escape, backdrop click, close button). */
  onClose: () => void;
}

const GAP_LABEL: Record<string, string> = {
  'legacy-missing': '旧数据缺失',
  'invalid-present': '字段损坏',
  unavailable: '不可获取',
};

const formatTs = (ms: number) => new Date(ms).toLocaleString();

export function SegmentReplayPanel({
  segmentId,
  threadId,
  turnId,
  catId,
  pipelineStatus,
  isOpen,
  onClose,
}: ReplayPanelProps) {
  const [data, setData] = useState<SegmentReplayResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reqRef = useRef(0);

  const fetchReplay = useCallback(async () => {
    const id = ++reqRef.current;
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({ threadId, turnId });
      const res = await apiFetch(`/api/segment-lifeline/${encodeURIComponent(segmentId)}/replay?${query}`);
      if (id !== reqRef.current) return;
      if (!res.ok) {
        setError('回放加载失败');
        return;
      }
      setData((await res.json()) as SegmentReplayResponse);
    } catch {
      if (id === reqRef.current) setError('网络错误');
    } finally {
      if (id === reqRef.current) setLoading(false);
    }
  }, [segmentId, threadId, turnId]);

  useEffect(() => {
    if (!isOpen) {
      setData(null);
      setError(null);
      return;
    }
    fetchReplay();
    return () => {
      reqRef.current++;
    };
  }, [isOpen, fetchReplay]);

  useEffect(() => {
    if (!isOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen) return;
    const previouslyHidden = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previouslyHidden;
    };
  }, [isOpen]);

  if (!isOpen || typeof document === 'undefined') return null;

  return createPortal(
    <ReplayOverlay onClose={onClose}>
      <ReplayPanelBody
        catId={catId}
        pipelineStatus={pipelineStatus}
        data={data}
        loading={loading}
        error={error}
        onClose={onClose}
      />
    </ReplayOverlay>,
    document.body,
  );
}

function ReplayOverlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[110] flex items-start justify-center p-4 sm:items-center">
      <button
        type="button"
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        data-testid="replay-backdrop"
        aria-label="关闭回放"
      />
      <div className="relative w-full max-w-5xl">{children}</div>
    </div>
  );
}

interface ReplayPanelBodyProps {
  catId: string;
  pipelineStatus: string;
  data: SegmentReplayResponse | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
}

function ReplayPanelBody({ catId, pipelineStatus, data, loading, error, onClose }: ReplayPanelBodyProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    const first = focusable[0] ?? panel;
    first.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Tab') return;
      const elements = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? []).filter(
        (el) => el.offsetParent !== null,
      );
      if (elements.length === 0) {
        e.preventDefault();
        return;
      }
      const firstEl = elements[0];
      const lastEl = elements[elements.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    }

    panel.addEventListener('keydown', onKeyDown);
    return () => panel.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      className="flex max-h-[90vh] w-full flex-col overflow-hidden rounded-2xl border border-[var(--console-border-soft)] bg-[var(--console-panel-bg)] shadow-2xl outline-none"
      role="dialog"
      aria-modal="true"
      aria-labelledby="replay-title"
    >
      <div className="flex items-center justify-between border-b border-[var(--console-border-soft)] px-4 py-3">
        <div className="flex items-center gap-2">
          <SettingsText as="h3" id="replay-title" variant="sm" tone="default" className="font-semibold">
            回放现场
          </SettingsText>
          <SettingsBadge tone={pipelineStatus === 'fired' ? 'emerald' : 'slate'} size="xxs">
            {pipelineStatus}
          </SettingsBadge>
          <span className="text-micro text-cafe-muted">@{catId}</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg p-1 text-cafe-muted hover:bg-[var(--console-elevated-bg)] hover:text-cafe"
          aria-label="关闭回放"
          data-testid="replay-close"
        >
          ✕
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 text-xs">
        {loading && (
          <SettingsText as="p" variant="xs" tone="muted">
            加载回放…
          </SettingsText>
        )}

        {!loading && (error || !data) && (
          <SettingsText as="p" variant="xs" tone="red">
            {error ?? '回放数据为空'}
          </SettingsText>
        )}

        {data && <ReplayDataSections data={data} />}
      </div>
    </div>
  );
}

function ReplayDataSections({ data }: { data: SegmentReplayResponse }) {
  return (
    <>
      <ReplayField label="来源" gap={data.messageAnchorIdGap}>
        <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-2 rounded-xl bg-[var(--console-card-bg)] p-3">
          <span className="text-cafe-muted">Thread</span>
          <a
            href={`/thread/${encodeURIComponent(data.threadId)}`}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="replay-thread-link"
            className="min-w-0 break-all font-mono text-cafe-accent underline-offset-2 hover:underline"
            aria-label={`在新窗口打开 Thread ${data.threadId}`}
          >
            {data.threadId}
          </a>
          <span className="text-cafe-muted">Message</span>
          <span className="min-w-0 break-all font-mono text-cafe-secondary">
            {data.messageAnchorId ?? '无消息锚点'}
          </span>
        </div>
      </ReplayField>

      <ReplayField label="上下文" gap={data.surroundingMessagesGap}>
        {data.surroundingMessages != null ? <SurroundingMessages messages={data.surroundingMessages} /> : null}
      </ReplayField>
    </>
  );
}

function SurroundingMessages({ messages }: { messages: NonNullable<SegmentReplayResponse['surroundingMessages']> }) {
  return (
    <div data-testid="replay-context-list" className="max-h-[60vh] space-y-1 overflow-auto">
      {messages.map((msg) => (
        <div key={msg.messageId} className="rounded-lg bg-[var(--console-card-bg)] px-2 py-1.5">
          <div className="mb-0.5 flex items-center gap-2">
            <SettingsBadge tone={msg.role === 'user' ? 'blue' : msg.role === 'system' ? 'amber' : 'slate'} size="xxs">
              {msg.role}
            </SettingsBadge>
            {msg.catId && <span className="text-cafe-muted">@{msg.catId}</span>}
            <span className="ml-auto text-cafe-muted">{formatTs(msg.timestamp)}</span>
          </div>
          <div className="pl-1 text-cafe-secondary">{msg.contentPreview}</div>
        </div>
      ))}
    </div>
  );
}

function ReplayField({ label, gap, children }: { label: string; gap: string | null; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <SettingsText as="h4" variant="xs" tone="muted" className="font-semibold">
          {label}
        </SettingsText>
        {gap && (
          <SettingsBadge tone="amber" size="xxs">
            {GAP_LABEL[gap] ?? gap}
          </SettingsBadge>
        )}
      </div>
      {children}
    </div>
  );
}
