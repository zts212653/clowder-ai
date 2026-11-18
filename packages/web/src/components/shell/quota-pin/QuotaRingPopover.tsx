'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEscapeToClose, useRailEdge } from '../mailbox/use-mailbox-panel-layout';
import { useShellCopy } from '../shell-copy';
import { QuotaRingAccountBody } from './QuotaRingAccountBody';
import { quotaPinCopy } from './quota-pin.shell-copy';
import type { QuotaRingAccountView } from './quota-pin-model';

function RefreshGlyph({ spinning }: { spinning: boolean }) {
  return (
    <svg
      className={spinning ? 'account-quota-spinning' : undefined}
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 7v5h-5M20 12a8 8 0 1 0-2.3 5.7M20 12l-3-5" />
    </svg>
  );
}

export function QuotaRingPopover({
  anchor,
  allEntries,
  effectiveIds,
  selectedEntries,
  refreshing,
  refreshError,
  onRefresh,
  onToggleAccount,
  onManageAccounts,
  onUnpin,
  onClose,
}: {
  anchor: React.RefObject<HTMLButtonElement | null>;
  allEntries: readonly QuotaRingAccountView[];
  effectiveIds: readonly string[];
  selectedEntries: readonly QuotaRingAccountView[];
  refreshing: boolean;
  refreshError: boolean;
  onRefresh: () => void;
  onToggleAccount: (accountId: string) => void;
  onManageAccounts: () => void;
  onUnpin: () => void;
  onClose: () => void;
}) {
  const t = useShellCopy(quotaPinCopy);
  const panelRef = useRef<HTMLDivElement>(null);
  const railEdge = useRailEdge(anchor);
  const [choosing, setChoosing] = useState(false);

  useEscapeToClose(panelRef, onClose);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target) || anchor.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [anchor, onClose]);

  const hasRefreshable = selectedEntries.some((entry) => entry.canRefresh);
  const isMobileNarrow = railEdge === 0;

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={t.title}
      data-testid="quota-ring-popover"
      data-chat-background-layer="work"
      data-chat-background-surface="frame"
      className="fixed z-[95] flex flex-col overflow-hidden rounded-[12px] text-compact"
      style={{
        left: isMobileNarrow ? 58 : (railEdge ?? 52) + 8,
        right: isMobileNarrow ? 8 : undefined,
        width: isMobileNarrow ? undefined : 328,
        bottom: 12,
        maxHeight: 'min(72dvh, calc(100dvh - 24px))',
        background: 'var(--shell-frame, var(--cafe-surface))',
        color: 'var(--shell-body, var(--cafe-text))',
        border: '1px solid var(--shell-hairline-strong, var(--console-border))',
        boxShadow: '0 6px 18px rgb(20 20 19 / 0.12)',
      }}
    >
      <div
        className="flex items-center justify-between gap-2 px-3.5 py-2.5"
        style={{ borderBottom: '1px solid var(--shell-hairline, var(--console-border-soft))' }}
      >
        <span className="text-compact font-medium" style={{ color: 'var(--shell-ink, var(--cafe-text))' }}>
          {choosing ? t.chooseAccounts : t.title}
        </span>
        <div className="flex items-center gap-1">
          {!choosing && (
            <button
              type="button"
              data-testid="quota-ring-refresh"
              aria-label={t.refreshHint}
              disabled={refreshing || !hasRefreshable}
              onClick={onRefresh}
              className="shell-nav-row shell-focusable inline-flex h-7 items-center gap-1 rounded-[8px] px-2 text-xs font-medium disabled:opacity-45"
              style={{ color: 'var(--shell-body, var(--cafe-text-secondary))' }}
            >
              <RefreshGlyph spinning={refreshing} />
              <span>{refreshing ? t.refreshing : t.refresh}</span>
            </button>
          )}
          <button
            type="button"
            data-testid="quota-ring-choose-accounts"
            data-selected={choosing ? 'true' : undefined}
            data-chat-background-surface={choosing ? 'selected' : undefined}
            onClick={() => setChoosing((prev) => !prev)}
            className="shell-nav-row shell-focusable inline-flex h-7 items-center rounded-[8px] px-2 text-xs font-medium"
            style={{
              background: choosing ? 'var(--shell-selected, var(--console-pill-bg))' : undefined,
              color: choosing ? 'var(--shell-ink, var(--cafe-text))' : 'var(--shell-muted, var(--cafe-text-muted))',
            }}
          >
            {choosing ? t.doneChoosing : t.chooseAccounts}
          </button>
        </div>
      </div>

      {refreshError && (
        <div
          role="alert"
          data-chat-background-surface="selected"
          className="px-3.5 py-1.5 text-xs"
          style={{
            background: 'var(--shell-selected, var(--console-field-bg))',
            color: 'var(--shell-body, var(--cafe-text-secondary))',
            borderBottom: '1px solid var(--shell-hairline, var(--console-border-soft))',
          }}
        >
          {t.refreshFailed}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <QuotaRingAccountBody
          choosing={choosing}
          allEntries={allEntries}
          effectiveIds={effectiveIds}
          selectedEntries={selectedEntries}
          onToggleAccount={onToggleAccount}
        />
      </div>

      <div
        className="flex items-center justify-between gap-2 px-3.5 py-2"
        style={{ borderTop: '1px solid var(--shell-hairline, var(--console-border-soft))' }}
      >
        <button
          type="button"
          data-testid="quota-ring-manage-accounts"
          onClick={onManageAccounts}
          className="shell-nav-row shell-focusable rounded-[8px] px-2 py-1 -ml-2 text-xs font-medium"
          style={{ color: 'var(--shell-ink, var(--cafe-text))' }}
        >
          {t.manageAccounts}
        </button>
        <button
          type="button"
          data-testid="quota-ring-unpin"
          onClick={onUnpin}
          className="shell-nav-row shell-focusable rounded-[8px] px-2 py-1 -mr-2 text-xs"
          style={{ color: 'var(--shell-muted, var(--cafe-text-muted))' }}
        >
          {t.unpin}
        </button>
      </div>
    </div>,
    document.body,
  );
}
