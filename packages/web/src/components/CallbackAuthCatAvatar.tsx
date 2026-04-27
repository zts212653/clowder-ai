'use client';

/**
 * F174 D2b-2 — drop-in replacement for `<CatAvatar>` that consumes the
 * global callback-auth store (zustand) to surface the per-cat status dot
 * + AC-D7 hover popover (reason×N + Top tools + 详情 link).
 *
 * Use this wherever a daily-visible roster of cat avatars lives — thread
 * sidebar participants, hub roster, leaderboard. Plain `<CatAvatar>`
 * remains for non-roster callsites (single-message author, task owner,
 * etc.) so the pattern stays opt-in.
 */

import { useCallback } from 'react';
import { useCallbackAuthAggregate, useCallbackAuthAvailable, useCallbackAuthByCat } from '@/stores/callbackAuthStore';
import { useChatStore } from '@/stores/chatStore';
import { CatAvatar } from './CatAvatar';

interface CallbackAuthCatAvatarProps {
  catId: string;
  size?: number;
  /** Forward to underlying CatAvatar — runtime cat status (streaming etc). */
  status?: React.ComponentProps<typeof CatAvatar>['status'];
}

export function CallbackAuthCatAvatar({ catId, size = 32, status }: CallbackAuthCatAvatarProps) {
  const cba = useCallbackAuthByCat(catId);
  const aggregate = useCallbackAuthAggregate();
  const isAvailable = useCallbackAuthAvailable();
  const openHub = useChatStore((s) => s.openHub);

  const handleOpenDetails = useCallback(() => {
    openHub('observability', 'callback-auth');
  }, [openHub]);

  // Cloud Codex #1403 (round 2 + 7): backend snapshot's recent24h.byCat ONLY
  // accumulates FAILURE events — an absent entry means "no failure record",
  // which is NOT the same as "known healthy". The cat may have had zero
  // callback calls in 24h (no data), or many successful calls. Conflating
  // both into green would give a false health signal on the primary status
  // surface. We surface `unknown` (gray) for absent entries so users can see
  // the difference.
  //   isAvailable=false (snapshot missing / non-owner) → no dot, plain avatar
  //   isAvailable=true + cba undefined → unknown (gray, "no data")
  //   isAvailable=true + cba present   → cba.status (degraded / broken)
  // (healthy/green never fires today — backend lacks per-cat call totals.
  //  When that surface lands, derive healthy = `calls>0 && failures=0`.)
  if (!isAvailable) {
    return <CatAvatar catId={catId} size={size} status={status} />;
  }

  const cbaStatus = cba?.status ?? 'unknown';
  const cbaFailures = cba?.failures24h ?? 0;
  const label = cba ? `${catId}: ${cbaStatus} · ${cbaFailures} fails (24h)` : `${catId}: 24h 内无失败记录`;
  const popover = (
    <div className="space-y-2 text-cafe">
      <div className="font-semibold">{label}</div>
      {aggregate.topReasons.length > 0 && (
        <div>
          <div className="mb-0.5 text-[10px] uppercase tracking-wide text-cafe-muted">Reasons (24h, all cats)</div>
          {aggregate.topReasons.slice(0, 3).map((r) => (
            <div key={r.name} className="flex items-center justify-between text-[11px]">
              <span className="font-mono">{r.name}</span>
              <span className="text-cafe-secondary">{r.count}</span>
            </div>
          ))}
        </div>
      )}
      {aggregate.topTools.length > 0 && (
        <div>
          <div className="mb-0.5 text-[10px] uppercase tracking-wide text-cafe-muted">Top Tools (24h, all cats)</div>
          {aggregate.topTools.slice(0, 3).map((t) => (
            <div key={t.name} className="flex items-center justify-between text-[11px]">
              <span className="font-mono">{t.name}</span>
              <span className="text-cafe-secondary">{t.count}</span>
            </div>
          ))}
        </div>
      )}
      <div className="pt-1 text-[10px] text-cafe-muted">点击跳 D2b-3 详情</div>
    </div>
  );

  return (
    <CatAvatar
      catId={catId}
      size={size}
      status={status}
      callbackAuthStatus={cbaStatus}
      callbackAuthLabel={label}
      callbackAuthPopover={popover}
      onCallbackAuthClick={handleOpenDetails}
    />
  );
}
