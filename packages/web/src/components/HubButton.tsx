'use client';

import { useCallbackAuthAggregate, useCallbackAuthAvailable } from '@/stores/callbackAuthStore';
import { useChatStore } from '@/stores/chatStore';

/**
 * F099 P1-2: Always-visible Hub entry in the top bar (gear icon).
 *
 * F174 D2b-2 (rev3): callback-auth UNREAD badge — replaces the rev2 "alert/CTA"
 * badge form which was rejected by 铲屎官 alpha 验收 #3 ("红点点开也点不掉
 * 很难受！点开直接进入了 可观测性！万一我想看的是原本的成员呢"). Three rev3
 * changes implementing the GitHub bell icon / Slack unread / iOS app badge
 * "未读 → 看过 → 消失" mental model:
 *   1. Badge uses `unviewedFailures24h` (server-tracked since lastViewedAt),
 *      not `totalFailures24h` — so it CAN be cleared.
 *   2. Click ALWAYS opens default Hub — no deep-link to observability/callback-auth
 *      (rev2 stole user's intent of opening default Hub).
 *   3. Badge size capped at maxWidth 22px — even "99+" can't overflow the
 *      hub icon (rev2's "16" badge was ~70% of hub icon visual area).
 *
 * Badge clears when user opens observability/callback-auth subtab — that
 * subtab calls `markViewed()` on mount, which POSTs to the server and
 * optimistically zeros local state.
 *
 * Rules:
 *   isAvailable=false                    → no badge (zero pollution for non-owner)
 *   24h unviewedFailures = 0             → no badge (all viewed)
 *   24h unviewedFailures 1-5             → amber badge with count
 *   24h unviewedFailures >= 6            → red badge with count
 *   total > 99                           → "99+" cap (with maxWidth 22px guard)
 */

const DEGRADED_COLOR = '#F59E0B';
const BROKEN_COLOR = '#EF4444';
const BROKEN_THRESHOLD = 6;

export function HubButton() {
  const openHub = useChatStore((s) => s.openHub);
  const aggregate = useCallbackAuthAggregate();
  const isAvailable = useCallbackAuthAvailable();

  const unviewed = isAvailable ? aggregate.unviewedFailures24h : 0;
  const showBadge = unviewed > 0;
  const badgeColor = unviewed >= BROKEN_THRESHOLD ? BROKEN_COLOR : DEGRADED_COLOR;
  const badgeText = unviewed > 99 ? '99+' : String(unviewed);
  // Factual tooltip — failure-only counter cannot prove "healthy" (砚砚 P2 #1410).
  // rev3: tooltip emphasizes "unread" (未查看) so user knows clicking subtab clears it.
  const tooltip = showBadge
    ? `Clowder AI Hub · MCP Callback Auth 24h ${unviewed} 次未查看失败 — 打开 Hub 查看可观测性子 tab 即可清除`
    : 'Clowder AI Hub';

  // rev3: ALWAYS default openHub() — no deep-link, even with badge. Click hub
  // = "open Hub at user's last/default state". User can navigate to observability/
  // callback-auth subtab themselves (which clears the badge via markViewed).
  const handleClick = () => {
    openHub();
  };

  return (
    <button
      onClick={handleClick}
      className="relative p-1 rounded-lg hover:bg-cocreator-light transition-colors"
      aria-label={tooltip}
      title={tooltip}
      data-bootcamp-step="hub-button"
      data-guide-id="hub.trigger"
      data-testid="hub-button"
      data-callback-auth-unviewed={showBadge ? String(unviewed) : undefined}
    >
      <svg
        className="w-5 h-5 text-cafe-secondary"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
      {showBadge && (
        <span
          data-testid="hub-button-callback-auth-badge"
          className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full text-[10px] font-bold flex items-center justify-center"
          // rev3: maxWidth 22px hard cap — even "99+" stays within budget so
          // badge never visually dominates the hub icon (alpha #3 had "16"
          // badge ~70% of hub icon area). overflow:hidden + ellipsis 防御性兜底
          // 即使未来 cap 字符变长也不会撑爆。
          style={{
            backgroundColor: badgeColor,
            color: '#FFFFFF',
            maxWidth: '22px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {badgeText}
        </span>
      )}
    </button>
  );
}
