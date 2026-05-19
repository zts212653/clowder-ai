'use client';

import { type ReactNode, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { hexToRgba } from '@/lib/color-utils';
import { PawIcon } from './icons/PawIcon';

type CatStatus = 'spawning' | 'pending' | 'streaming' | 'done' | 'error' | 'alive_but_silent' | 'suspected_stall';

/** F174 D2b-2 — callback-auth health (per cat, derived from /api/debug/callback-auth snapshot). */
export type CallbackAuthStatus = 'healthy' | 'degraded' | 'broken' | 'unknown';

const CALLBACK_AUTH_STATUS_COLOR: Record<CallbackAuthStatus, string> = {
  healthy: '#22C55E',
  degraded: '#F59E0B',
  broken: '#EF4444',
  unknown: '#A89386',
};

interface CatAvatarProps {
  catId: string;
  size?: number;
  status?: CatStatus;
  /** F174 D2b-2: corner status dot for callback-auth health surface (明厨亮灶 实体层). */
  callbackAuthStatus?: CallbackAuthStatus;
  /** Optional aria-label / hover hint for the status dot (e.g. "broken · 12 fails"). */
  callbackAuthLabel?: string;
  /**
   * F174 D2b-2 AC-D7: rich popover rendered on dot hover. When provided
   * (and onCallbackAuthClick set), the dot becomes a clickable entry
   * point — e.g. jump to D2b-3 deep-dive panel.
   */
  callbackAuthPopover?: ReactNode;
  /** F174 D2b-2 AC-D7: click handler for the dot (typically opens D2b-3). */
  onCallbackAuthClick?: () => void;
}

export function CatAvatar({
  catId,
  size = 32,
  status,
  callbackAuthStatus,
  callbackAuthLabel,
  callbackAuthPopover,
  onCallbackAuthClick,
}: CatAvatarProps) {
  const [imgError, setImgError] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const { getCatById } = useCatData();
  const cat = getCatById(catId);

  const isStreaming = status === 'streaming';
  const isError = status === 'error';
  const ringColor = cat?.color.primary ?? '#9CA3AF'; // gray-400 fallback
  const glowShadow = isStreaming && cat ? `0 0 10px ${hexToRgba(ringColor, 0.5)}` : undefined;

  // F174 D2b-2: dot is ~28% of avatar size (min 8px), absolute positioned bottom-right.
  // White ring lifts it off the avatar and survives most cat colors.
  const dotSize = Math.max(8, Math.round(size * 0.28));
  const dotBorder = Math.max(1, Math.round(dotSize * 0.18));

  return (
    <div className="relative flex-shrink-0" style={{ width: size, height: size }}>
      <div
        className={`rounded-full ring-2 overflow-hidden bg-cafe-surface-elevated flex items-center justify-center transition-shadow duration-300 ${
          isStreaming ? 'animate-pulse' : ''
        }`}
        style={{
          width: size,
          height: size,
          ['--tw-ring-color' as string]: isError ? '#ef4444' : ringColor,
          boxShadow: glowShadow,
        }}
      >
        {imgError ? (
          <PawIcon className="text-base" />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={cat?.avatar ?? `/avatars/${catId}.png`}
            alt={cat?.displayName ?? catId}
            width={size}
            height={size}
            className="object-cover"
            onError={() => setImgError(true)}
          />
        )}
      </div>
      {callbackAuthStatus && (
        <span
          className="absolute"
          style={{ right: -dotBorder, bottom: -dotBorder }}
          onMouseEnter={() => callbackAuthPopover && setPopoverOpen(true)}
          onMouseLeave={() => setPopoverOpen(false)}
        >
          {onCallbackAuthClick ? (
            <button
              type="button"
              data-testid="callback-auth-dot"
              data-callback-auth-status={callbackAuthStatus}
              aria-label={callbackAuthLabel ?? `callback-auth: ${callbackAuthStatus}`}
              title={callbackAuthLabel ?? `callback-auth: ${callbackAuthStatus}`}
              onClick={(e) => {
                // 砚砚 P2 #1403: dot lives inside CatAvatar callsites that are
                // themselves clickable (e.g. ThreadItem row → onSelect). Without
                // stopPropagation, opening the D2b-3 panel would also switch
                // threads — a hidden context jump.
                e.stopPropagation();
                onCallbackAuthClick();
              }}
              className="block rounded-full p-0 hover:scale-110 transition-transform cursor-pointer"
              style={{
                width: dotSize,
                height: dotSize,
                backgroundColor: CALLBACK_AUTH_STATUS_COLOR[callbackAuthStatus],
                border: `${dotBorder}px solid #FFFFFF`,
              }}
            />
          ) : (
            <span
              role="status"
              data-testid="callback-auth-dot"
              data-callback-auth-status={callbackAuthStatus}
              aria-label={callbackAuthLabel ?? `callback-auth: ${callbackAuthStatus}`}
              title={callbackAuthLabel ?? `callback-auth: ${callbackAuthStatus}`}
              className="block rounded-full"
              style={{
                width: dotSize,
                height: dotSize,
                backgroundColor: CALLBACK_AUTH_STATUS_COLOR[callbackAuthStatus],
                border: `${dotBorder}px solid #FFFFFF`,
              }}
            />
          )}
          {popoverOpen && callbackAuthPopover && (
            <div
              data-testid="callback-auth-popover"
              className="absolute z-50 mt-1 rounded-lg border border-cafe-border bg-cafe-surface p-3 text-xs shadow-xl"
              style={{ top: dotSize + dotBorder, right: 0, minWidth: 200, maxWidth: 280 }}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            >
              {callbackAuthPopover}
            </div>
          )}
        </span>
      )}
    </div>
  );
}
