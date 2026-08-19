'use client';

import { type PointerEvent, useEffect, useState } from 'react';
import { useConciergeStore } from '@/stores/conciergeStore';
import { CafeIcon } from '../rich/CafeIcons';
import { ConciergePetSprite } from './ConciergeBall';

type InvocationStatus = 'idle' | 'pending' | 'in_progress' | 'error';

export function resolvePanelPetState(status: InvocationStatus, hasFreshReply: boolean): string {
  if (status === 'error') return 'failed';
  if (status === 'pending' || status === 'in_progress') return 'running';
  if (hasFreshReply) return 'jumping';
  return 'idle';
}

function TooltipAction({ id, label, icon, onClick }: { id: string; label: string; icon: string; onClick: () => void }) {
  const tooltipId = `concierge-${id}-tooltip`;
  return (
    <div className="group relative flex items-center">
      <button
        type="button"
        aria-label={label}
        aria-describedby={tooltipId}
        onClick={onClick}
        style={{ color: 'var(--cafe-text-muted)' }}
        className="p-1.5 rounded-md transition-colors duration-150 hover:bg-[var(--cafe-surface-elevated)] hover:text-[var(--cafe-text)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--cafe-accent)]"
      >
        <CafeIcon name={icon} className="w-4 h-4" />
      </button>
      <span
        id={tooltipId}
        role="tooltip"
        style={{
          backgroundColor: 'var(--cafe-text)',
          color: 'var(--cafe-surface-canvas)',
          boxShadow: 'var(--shadow-elevation-1)',
        }}
        className="pointer-events-none absolute right-0 top-[calc(100%+6px)] z-30 whitespace-nowrap rounded-md px-2 py-1 text-xs opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {label}
      </span>
    </div>
  );
}

export function ConciergePanelHeader({
  title,
  invocationStatus,
  muted,
  isExpanded,
  onVisibilityToggle,
  onToggleExpanded,
  onClose,
}: {
  title: string;
  invocationStatus: InvocationStatus;
  muted: boolean;
  isExpanded: boolean;
  onVisibilityToggle: () => void;
  onToggleExpanded: () => void;
  onClose: () => void;
}) {
  const skin = useConciergeStore((s) => s.skin);
  const lastMessageTimestamp = useConciergeStore((s) => s.lastMessageTimestamp);
  const [hasFreshReply, setHasFreshReply] = useState(false);

  useEffect(() => {
    const remainingMs = 2000 - (Date.now() - lastMessageTimestamp);
    if (lastMessageTimestamp <= 0 || remainingMs <= 0) {
      setHasFreshReply(false);
      return;
    }
    setHasFreshReply(true);
    const timer = setTimeout(() => setHasFreshReply(false), remainingMs);
    return () => clearTimeout(timer);
  }, [lastMessageTimestamp]);

  const petState = resolvePanelPetState(invocationStatus, hasFreshReply);
  const visibilityLabel = muted ? '显示猫猫球' : '隐藏猫猫球';
  const expandLabel = isExpanded ? '恢复面板大小' : '放大面板';

  return (
    <div
      style={{ borderBottomColor: 'var(--cafe-border-subtle)' }}
      className="flex min-h-12 items-center gap-2 border-b px-3 py-2"
    >
      <span
        data-testid="concierge-status-avatar"
        data-pet-state={petState}
        role="img"
        aria-label={`值班猫状态：${petState}`}
        className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-[var(--cafe-surface-elevated)]"
      >
        <ConciergePetSprite state={petState} skin={skin} size={36} />
      </span>
      <span style={{ color: 'var(--cafe-text)' }} className="min-w-0 flex-1 truncate text-sm font-semibold">
        {title}
      </span>
      {invocationStatus === 'error' && (
        <output style={{ color: 'var(--semantic-critical)' }} className="text-xs">
          连接失败
        </output>
      )}
      <button
        type="button"
        aria-label={visibilityLabel}
        onClick={onVisibilityToggle}
        style={{
          color: muted ? 'var(--semantic-warning)' : 'var(--cafe-text-secondary)',
          borderColor: 'var(--cafe-border-subtle)',
        }}
        className="flex shrink-0 items-center gap-1 rounded-lg border px-2 py-1 text-xs transition-colors hover:bg-[var(--cafe-surface-elevated)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--cafe-accent)]"
      >
        <CafeIcon name={muted ? 'eye' : 'eye-off'} className="h-3.5 w-3.5" />
        {muted ? '显示' : '隐藏'}
      </button>
      <TooltipAction
        id="panel-size"
        label={expandLabel}
        icon={isExpanded ? 'contract' : 'expand'}
        onClick={onToggleExpanded}
      />
      <TooltipAction id="panel-close" label="关闭面板" icon="cross" onClick={onClose} />
    </div>
  );
}

interface ResizeHandlers {
  onPointerDown: (event: PointerEvent) => void;
  onPointerMove: (event: PointerEvent) => void;
  onPointerUp: () => void;
}

export function ConciergePanelResizeHandles({
  width,
  height,
  corner,
}: {
  width: ResizeHandlers;
  height: ResizeHandlers;
  corner: ResizeHandlers;
}) {
  return (
    <>
      <div
        aria-hidden="true"
        onPointerDown={width.onPointerDown}
        onPointerMove={width.onPointerMove}
        onPointerUp={width.onPointerUp}
        className="absolute bottom-0 left-0 top-0 z-10 w-1.5 cursor-ew-resize rounded-l-2xl transition-colors hover:bg-[var(--cafe-accent)] hover:opacity-30"
      />
      <div
        aria-hidden="true"
        onPointerDown={height.onPointerDown}
        onPointerMove={height.onPointerMove}
        onPointerUp={height.onPointerUp}
        className="absolute left-0 right-0 top-0 z-10 h-1.5 cursor-ns-resize rounded-t-2xl transition-colors hover:bg-[var(--cafe-accent)] hover:opacity-30"
      />
      <div
        aria-hidden="true"
        data-testid="concierge-resize-grip"
        onPointerDown={corner.onPointerDown}
        onPointerMove={corner.onPointerMove}
        onPointerUp={corner.onPointerUp}
        style={{
          color: 'var(--cafe-text-muted)',
          backgroundColor: 'var(--cafe-surface-elevated)',
          borderColor: 'var(--cafe-border-subtle)',
        }}
        className="absolute -left-2 -top-2 z-20 flex h-6 w-6 cursor-nwse-resize items-center justify-center rounded-full border shadow-[var(--shadow-elevation-1)] transition-colors hover:text-[var(--cafe-accent)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--cafe-accent)]"
      >
        <CafeIcon name="resize" className="h-3.5 w-3.5" />
      </div>
    </>
  );
}
