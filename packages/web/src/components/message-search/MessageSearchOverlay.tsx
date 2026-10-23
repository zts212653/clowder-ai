'use client';

import { MessageReadingControls } from './MessageReadingControls';
import { MessageSearchPanel } from './MessageSearchPanel';
import type { MessageSearchHost } from './useMessageSearchHost';

export function MessageSearchOverlay({
  threadId,
  host,
  available,
  resolveSpeaker,
}: {
  threadId: string;
  host: MessageSearchHost;
  available: boolean;
  resolveSpeaker?: (speaker: string) => string;
}) {
  const trip = host.session?.trip;
  if (!available || typeof document === 'undefined') return null;
  if (!host.open && (!trip || trip.status === 'completed') && !host.notice) return null;
  return (
    <aside
      className={
        host.open
          ? 'absolute right-3 top-[calc(env(safe-area-inset-top,0px)+60px)] z-[70] w-[min(520px,calc(100%-24px))]'
          : 'z-[70] shrink-0 px-3 py-2'
      }
      aria-label="消息找回"
    >
      {host.open ? (
        <MessageSearchPanel
          threadId={threadId}
          onClose={host.closeSearch}
          onNavigate={host.navigateResult}
          resolveSpeaker={resolveSpeaker}
        />
      ) : (
        <MessageReadingControls host={host} />
      )}
      {host.notice && (
        <output
          aria-live="polite"
          className="mt-2 block rounded-lg bg-[var(--console-card-bg)] p-2 text-xs text-cafe-secondary"
        >
          {host.notice}
        </output>
      )}
    </aside>
  );
}
