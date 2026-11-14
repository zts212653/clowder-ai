'use client';

import { useShellPresentation } from '../shell/shell-presentation';
import { MessageReadingControls } from './MessageReadingControls';
import { MessageSearchPanel } from './MessageSearchPanel';
import { captureFindWorkspaceOrigin } from './message-find-destinations';
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
  const journey6 = useShellPresentation() === 'v2';
  const hiddenJump = host.session?.source === 'jump' && trip?.origin.threadId !== threadId;
  if (!available || typeof document === 'undefined') return null;
  if (!host.open && (!trip || trip.status === 'completed' || hiddenJump) && !host.notice) return null;
  const body = (
    <>
      {host.open ? (
        <MessageSearchPanel
          key={host.findState ? host.findSeed : 'manual'}
          threadId={threadId}
          onClose={host.closeSearch}
          onNavigate={host.navigateResult}
          resolveSpeaker={resolveSpeaker}
          initialState={host.findState}
          onOpenDestination={(destination, state) =>
            host.openDestination(destination, state, captureFindWorkspaceOrigin())
          }
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
    </>
  );
  // An in-thread jump (看回复 / 跳到原文 / reply pills …) leaves the return bar up until the reader uses it, so it must
  // not cost the reading column a full-width row: zero-height anchor in the flow, the bar itself floats over the
  // column's top edge (north-star §1.9 draws it as a pill over the conversation). Find keeps its own row.
  if (!host.open && host.session?.source === 'jump') {
    return (
      <aside className="pointer-events-none relative z-[70] h-0 shrink-0" aria-label="消息找回">
        {/* right-9 clears the message navigator rail (right-0.5 + w-5/w-6) in both shells. */}
        <div className="pointer-events-auto absolute right-9 top-2 w-fit max-w-[calc(100%-3rem)]">{body}</div>
      </aside>
    );
  }
  return (
    <aside
      className={
        host.open
          ? `absolute right-3 top-[calc(env(safe-area-inset-top,0px)+60px)] z-[70] ${journey6 ? 'w-[min(720px,calc(100%-24px))]' : 'w-[min(520px,calc(100%-24px))]'}`
          : 'z-[70] shrink-0 px-3 py-2'
      }
      aria-label="消息找回"
    >
      {body}
    </aside>
  );
}
