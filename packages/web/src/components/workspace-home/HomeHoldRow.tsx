'use client';

import type { ActiveHoldWaitProjection } from '@cat-cafe/shared';
import { useState } from 'react';
import { AppTooltip } from '@/components/AppTooltip';
import { CatAvatar } from '@/components/CatAvatar';
import { formatWakeTime } from '@/components/execution-row/row-model';
import { useShellCopy } from '@/components/shell/shell-copy';
import { getThreadHref, pushThreadRouteWithHistory } from '@/components/ThreadSidebar/thread-navigation';
import { cancelHoldWait } from '@/hooks/useActiveExecutionProjection';
import { useChatStore } from '@/stores/chatStore';
import { homeCopy } from './workspace-home.shell-copy';

/**
 * A held ball on Home's 正在发生: the cat's run ended and a wake is armed. It reads 在等 with the wall-clock wake
 * time the hold card states, never a running clock. Cancel is the hold card's own 取消持球 (no confirmation there
 * either); another principal's hold is shown without one.
 */
export function HomeHoldRow({
  wait,
  catName,
  here,
}: {
  wait: ActiveHoldWaitProjection;
  catName: string;
  here: boolean;
}) {
  const t = useShellCopy(homeCopy).live;
  const [busy, setBusy] = useState(false);
  const title = wait.threadTitle ?? wait.threadId;
  return (
    <article
      className="home-live-row"
      data-testid="workspace-holding-object"
      data-here={here ? 'true' : undefined}
      data-wait-id={wait.waitId}
      data-execution-thread-id={wait.threadId}
    >
      <a
        href={getThreadHref(wait.threadId)}
        className="home-live-main home-live-link shell-focusable"
        onClick={(event) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          pushThreadRouteWithHistory(wait.threadId, window);
          useChatStore.getState().closeRightPanel();
        }}
      >
        <span className="home-live-heading">
          <span role="img" aria-label={catName} className="flex-shrink-0">
            <span aria-hidden="true">
              <CatAvatar catId={wait.catId} size={20} ring="none" />
            </span>
          </span>
          <span className="home-live-name text-compact">{catName}</span>
          <span className="home-live-status text-xs" data-tone="wait" title={t.holding}>
            <span className="home-execution-status-dot" aria-hidden="true" />
            <span>{t.holding}</span>
          </span>
          <small className="home-live-clock text-xs">{t.wakesAt(formatWakeTime(wait.wakeAt))}</small>
        </span>
        <span className="home-live-sub text-xs" title={title}>
          {here && <span>{t.here} · </span>}
          {title}
        </span>
      </a>
      <div className="home-live-actions">
        {wait.cancelability.state === 'cancelable' ? (
          <AppTooltip label={t.cancelHold(catName)} side="top">
            <button
              type="button"
              className="home-stop shell-focusable"
              data-testid="home-cancel-hold"
              aria-label={t.cancelHold(catName)}
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void Promise.resolve(cancelHoldWait(wait))
                  .catch(() => false)
                  .finally(() => setBusy(false));
              }}
            >
              <span aria-hidden="true">{busy ? '…' : '×'}</span>
            </button>
          </AppTooltip>
        ) : null}
      </div>
    </article>
  );
}
