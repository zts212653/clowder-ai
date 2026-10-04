'use client';

/**
 * F229 PR-A2: ConciergeRailToggle — ActivityBar re-entry toggle
 *
 * INV-3: when ball is hidden (muted=true), this is the ONLY wake path back to the concierge.
 * P2 R6: gated on configLoaded/configFailed — prevents panelOpen race during startup
 *        (store starts enabled=true optimistically; we must not let users click before we
 *        know their persisted preference, or an opted-out panel can remain open).
 */

import { showConciergeDesktop, useConciergeDesktopStore } from '@/stores/conciergeDesktopStore';
import { useConciergeStore } from '@/stores/conciergeStore';
import { CafeIcon } from '../rich/CafeIcons';

/**
 * The re-entry contract (INV-3 / P2 R6) as a hook, so the classic rail button and the F322 v2 rail button
 * share ONE source of truth for when the entry exists and what a click does.
 */
export function useConciergeRailToggle(): {
  visible: boolean;
  isOpen: boolean;
  label: string;
  onClick: () => Promise<void>;
} {
  const desktopAvailable = useConciergeDesktopStore((s) => s.available);
  const configLoaded = useConciergeStore((s) => s.configLoaded);
  const configFailed = useConciergeStore((s) => s.configFailed);
  const enabled = useConciergeStore((s) => s.enabled);
  const surfaceState = useConciergeStore((s) => s.surfaceState);
  const muted = useConciergeStore((s) => s.muted);
  const setSurfaceState = useConciergeStore((s) => s.setSurfaceState);
  const setMuted = useConciergeStore((s) => s.setMuted);

  // P2 R6: don't render until config is known — prevents surfaceState race during startup
  const visible = (configLoaded || configFailed) && enabled;
  const isOpen = surfaceState !== 'collapsed';
  const onClick = async () => {
    if (desktopAvailable && (await showConciergeDesktop())) return;
    if (isOpen) {
      setSurfaceState('collapsed');
      return;
    }
    if (muted) void setMuted(false);
    setSurfaceState('toolbar');
  };
  const label = isOpen ? '收起猫猫球' : muted ? '显示猫猫球' : '打开猫猫球';
  return { visible, isOpen, label, onClick };
}

export function ConciergeRailToggle() {
  const { visible, isOpen, label, onClick } = useConciergeRailToggle();
  if (!visible) return null;

  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-10 w-10 items-center justify-center rounded-lg transition-all ${
        isOpen
          ? 'bg-[var(--console-rail-active)] shadow-[var(--console-rail-shadow)]'
          : 'hover:bg-[var(--console-rail-item)] hover:shadow-[var(--console-rail-shadow)]'
      }`}
      title={label}
      aria-label={label}
      data-testid="concierge-rail-toggle"
    >
      <CafeIcon name="cat" className="w-5 h-5" />
    </button>
  );
}
