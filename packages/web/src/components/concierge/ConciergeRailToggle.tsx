'use client';

/** Explicit shared shell entry: show an available desktop, otherwise open canonical companion Chat. */

import { showConciergeDesktop, useConciergeDesktopStore } from '@/stores/conciergeDesktopStore';
import { useConciergeStore } from '@/stores/conciergeStore';
import { CafeIcon } from '../rich/CafeIcons';
import { openCompanionConversation } from './companion-entry';

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
  const entryFailed = useConciergeStore((s) => s.invocationStatus === 'error');
  const visible = configLoaded || configFailed;
  const isOpen = false;
  const onClick = async () => {
    if (desktopAvailable && (await showConciergeDesktop())) return;
    await openCompanionConversation();
  };
  const label = desktopAvailable ? '唤回桌面猫猫' : entryFailed ? '伴随对话未能打开，点击重试' : '打开伴随对话';
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
