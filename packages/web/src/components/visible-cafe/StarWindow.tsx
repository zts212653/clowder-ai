/**
 * F258 Visible Cafe -- StarWindow
 *
 * Renders star lights in the window area, each representing an active thread.
 * Position = hash(threadId), deterministic and stable.
 * Brightness = recency of activity (1.0 = just active, 0 = cold).
 *
 * Phase B: Stars are clickable (KD-5: touch-first, no hover).
 * Click opens a StarCard showing the thread's cat and activity.
 *
 * INV-7: capped at MAX_STAR_LIGHTS (24).
 *
 * Defense Line 1: zero state. All data from props.
 */

'use client';

import type { StarLight } from '@/lib/visible-cafe/presence-types';

interface StarWindowProps {
  /** Star lights data from store. Already capped at MAX_STAR_LIGHTS. */
  starLights: StarLight[];
  /** Whether we're in quiet hours (stars stop flickering). */
  isQuiet: boolean;
  /** Phase B: Callback when a star is clicked. */
  onStarClick?: (threadId: string) => void;
}

const STAR_POSITION_INSET_PERCENT = 12;

export function StarWindow({ starLights, isQuiet, onStarClick }: StarWindowProps) {
  return (
    <div
      className="star-window"
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        // Phase B: allow pointer events so stars are clickable
        pointerEvents: onStarClick ? 'auto' : 'none',
      }}
    >
      {starLights.map((light) => (
        <Star key={light.threadId} light={light} isQuiet={isQuiet} onStarClick={onStarClick} />
      ))}
      <div
        className="absolute bottom-2 left-2 right-2 z-10 rounded-lg border px-2 py-1 text-center text-xs font-medium leading-tight shadow-lg backdrop-blur-sm"
        style={{
          pointerEvents: 'none',
          color: 'var(--overlay-fg)',
          background: 'var(--console-overlay-control)',
          borderColor: 'var(--console-border-soft)',
        }}
      >
        {starLights.length > 0 ? '亮着的星球可以点开' : '窗外的星球现在都暗着'}
      </div>
    </div>
  );
}

function Star({
  light,
  isQuiet,
  onStarClick,
}: {
  light: StarLight;
  isQuiet: boolean;
  onStarClick?: (threadId: string) => void;
}) {
  const size = 12 + light.brightness * 8; // 12-20px: visible as a planet, not a dust mote
  const alpha = 0.55 + light.brightness * 0.45; // 0.55-1.0

  // Phase B: clickable stars need a larger touch target (44px minimum for touch-first)
  const hitAreaSize = Math.max(44, size * 2);

  return (
    <button
      type="button"
      onClick={onStarClick ? () => onStarClick(light.threadId) : undefined}
      style={{
        position: 'absolute',
        left: `${STAR_POSITION_INSET_PERCENT + light.x * (100 - STAR_POSITION_INSET_PERCENT * 2)}%`,
        top: `${STAR_POSITION_INSET_PERCENT + light.y * (100 - STAR_POSITION_INSET_PERCENT * 2)}%`,
        // Touch target centered on the star
        width: hitAreaSize,
        height: hitAreaSize,
        transform: 'translate(-50%, -50%)',
        // Invisible button wrapping the visible star
        background: 'none',
        border: 'none',
        padding: 0,
        cursor: onStarClick ? 'pointer' : 'default',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      aria-label={`打开猫猫星球 · ${light.threadId.slice(-6)}`}
    >
      {/* Visible planet marker: the ring makes the interaction legible without inventing state. */}
      <div
        data-star-marker
        style={{
          position: 'relative',
          width: size,
          height: size,
          borderRadius: '50%',
          border: `1px solid rgba(255, 248, 220, ${Math.min(1, alpha + 0.15)})`,
          background: `radial-gradient(circle at 35% 30%, rgba(255, 255, 245, ${alpha}) 0%, rgba(250, 204, 108, ${alpha}) 42%, rgba(154, 92, 190, ${alpha * 0.9}) 100%)`,
          boxShadow: `0 0 ${size * 1.6}px rgba(255, 226, 150, ${alpha * 0.75})`,
          transition: isQuiet ? 'opacity 2s ease' : 'opacity 0.5s ease',
          pointerEvents: 'none', // let the button handle clicks
        }}
      >
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            width: size * 1.55,
            height: Math.max(4, size * 0.42),
            border: `1px solid rgba(255, 244, 204, ${alpha * 0.85})`,
            borderRadius: '50%',
            transform: 'translate(-50%, -50%) rotate(-18deg)',
            boxShadow: `0 0 ${size}px rgba(255, 226, 150, ${alpha * 0.35})`,
          }}
        />
      </div>
    </button>
  );
}
