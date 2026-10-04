'use client';

import { useCatData } from '@/hooks/useCatData';
import { useSidebarProjectionStore } from '@/stores/sidebarProjectionStore';
import { AppTooltip } from '../AppTooltip';
import { knownCatName, ShellCatAvatar, UNKNOWN_CAT_NAME } from './ShellCatAvatar';

const SHOWN = 6;

/**
 * 参与的猫 — the cats that have joined this conversation. The sidebar row no longer carries an avatar strip,
 * so this is where the roster lives; hover/focus names every one of them, including the ones past the visible six.
 */
export function HeaderParticipants({ threadId }: { threadId: string }) {
  const { getCatById } = useCatData();
  const participants = useSidebarProjectionStore(
    (state) => state.rows.find((row) => row.id === threadId)?.participants,
  );
  if (!participants || participants.length === 0) return null;

  const names = participants.map((catId) => knownCatName(catId, getCatById) ?? UNKNOWN_CAT_NAME);
  const shown = participants.slice(0, SHOWN);
  const extra = participants.length - shown.length;
  const summary = `参与的猫：${names.join('、')}`;

  return (
    <AppTooltip label="参与的猫" detail={names.join('、')} side="bottom">
      <div
        role="group"
        aria-label={summary}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: hover-only roster needs keyboard focus to reveal the tip
        tabIndex={0}
        data-testid="header-participants"
        className="shell-focusable mr-1 flex flex-none items-center rounded-full"
      >
        {shown.map((catId, index) => (
          <span
            key={catId}
            className="inline-flex rounded-full"
            style={{ marginLeft: index === 0 ? 0 : -6, boxShadow: '0 0 0 2px var(--shell-work)' }}
          >
            <ShellCatAvatar catId={catId} size={22} />
          </span>
        ))}
        {extra > 0 && (
          <span className="ml-1.5 text-xs tabular-nums" style={{ color: 'var(--shell-muted)' }}>
            +{extra}
          </span>
        )}
      </div>
    </AppTooltip>
  );
}
