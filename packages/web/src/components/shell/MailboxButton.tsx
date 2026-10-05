'use client';

import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import { useChatStore } from '@/stores/chatStore';
import { MailboxPanel } from './MailboxPanel';
import { openExactPlace } from './mailbox/open-exact-place';
import type { OriginalPlace } from './mailbox/original-place';
import { useApprovalSessions } from './mailbox/use-approval-sessions';
import { type RailBadge, RailButton } from './RailButton';
import { ShellGlyph } from './ShellIcons';
import {
  deriveMailboxState,
  MAILBOX_NAME,
  type MailboxState,
  mailboxAccessibleName,
  mailboxStateText,
} from './unified-mailbox-state';
import { useOpenInChat } from './use-open-in-chat';
import { useUnifiedAttention } from './use-unified-attention';

function badgeFor(state: MailboxState): RailBadge {
  switch (state.kind) {
    case 'has-items':
      // 1.6 board: a dot only means "confirmed items, total unconfirmed". Part of the read missing is a "!", with or without items.
      if (state.partial) return 'alert';
      return state.count !== null ? { count: state.count } : 'dot';
    case 'loading':
      return 'loading';
    case 'partial':
    case 'unavailable':
      return 'alert';
    case 'empty':
    case 'login-required':
      return null;
  }
}

/**
 * 小信箱 — the ONE rail entry for "things waiting on me". It reads F310's unified attention read once, and everything it
 * says (number, dot, empty, partial, unavailable, needs login) comes from `deriveMailboxState`. Rows open the item's
 * original place (审批 or 等你判断/需要修复); this entry never approves, admits or dispatches anything itself.
 */
export function MailboxButton() {
  const pathname = usePathname() ?? '/';
  const view = useUnifiedAttention();
  // Decisions made on an approval's original card are followed here, not in the panel: the panel closes, the decision goes on.
  const sessions = useApprovalSessions(view);
  const state = deriveMailboxState(view.result);
  const setWorkspaceMode = useChatStore((s) => s.setWorkspaceMode);
  const fetchPending = useApprovalHubStore((s) => s.fetchPending);
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Leaving the page closes the panel: it belongs to the place it was opened from.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the intentional trigger
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) buttonRef.current?.focus();
  }, []);

  // An exact place is reached directly (the source message, a collective-work result). A list is a workspace panel,
  // and opening a panel needs a chat route to host the Workspace; from elsewhere go back to the last thread first.
  const openInChat = useOpenInChat();
  const openPlace = useCallback(
    (place: OriginalPlace) => {
      setOpen(false);
      if (place.kind === 'exact') {
        openExactPlace(place.actionRef, pathname);
        return;
      }
      openInChat(() => {
        setWorkspaceMode(place.destination);
        if (place.destination === 'approval') void fetchPending();
      });
    },
    [openInChat, setWorkspaceMode, fetchPending, pathname],
  );

  const stateText = mailboxStateText(state);
  return (
    <>
      <RailButton
        ref={buttonRef}
        ariaLabel={mailboxAccessibleName(state)}
        tip={MAILBOX_NAME}
        tipDetail={stateText}
        badge={badgeFor(state)}
        dimmed={state.kind === 'login-required'}
        selected={open}
        ariaExpanded={open}
        ariaHasPopup="dialog"
        disableTip={open}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        testId="mailbox-button"
        guideId="rail.mailbox"
      >
        <ShellGlyph name="inbox" className="h-5 w-5" />
      </RailButton>
      {open && (
        <MailboxPanel
          anchor={buttonRef}
          state={state}
          view={view}
          sessions={sessions}
          onOpenPlace={openPlace}
          onClose={() => close(true)}
        />
      )}
    </>
  );
}
