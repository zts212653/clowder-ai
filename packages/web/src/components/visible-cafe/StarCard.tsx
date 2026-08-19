/**
 * F258 Visible Cafe -- StarCard (Phase B)
 *
 * Popup card when clicking a star in the window.
 * Shows: thread title + bound cat posture + provenance.
 *
 * U1 red line: each card = one thread = that thread's one cat.
 * Never aggregate across threads.
 *
 * Skin fallback chain:
 *   - xianxian threads -> CatSprite (full sprite rendering)
 *   - other cats -> stardust glow point + cat name label
 *
 * Defense Line 1: zero state. All data from props (StarCardSnapshot).
 * KD-5: click to expand (touch-first), no hover interactions.
 */

import type { SkinManifest } from '@/lib/visible-cafe/asset-config';
import type { StarCardSnapshot } from '@/lib/visible-cafe/presence-types';
import typographyTokens from '@/styles/typography-tokens.json';
import { CatSprite } from './CatSprite';

interface StarCardProps {
  card: StarCardSnapshot;
  skin: SkinManifest;
  now: number;
  onClose: () => void;
}

/**
 * Determine if a catId is xianxian (has skin assets).
 * Phase B: only xianxian has full sprite; others get stardust.
 */
function isXianxian(catId: string): boolean {
  return catId === 'opus' || catId === 'fable-5' || catId === 'sonnet' || catId === 'opus-47' || catId === 'opus-48';
}

/** Human-readable posture label. */
function postureLabel(posture: string): string {
  switch (posture) {
    case 'working':
      return 'working';
    case 'idle':
      return 'idle';
    case 'sleeping':
      return 'sleeping';
    default:
      return posture;
  }
}

/** Status indicator color based on state. */
function stateColor(state: string): string {
  switch (state) {
    case 'live':
      return '#4ade80'; // green
    case 'stale':
      return '#fbbf24'; // amber
    default:
      return '#6b7280'; // gray
  }
}

export function StarCard({ card, skin, now, onClose }: StarCardProps) {
  const hasSprite = isXianxian(card.catId);

  // Build a minimal snapshot for CatSprite rendering.
  // expiresAt is set to now + 5min so CatSprite.pickPosture() respects
  // the posture we already computed in deriveStarCardSnapshot().
  // Without this, idle/working snapshots whose lastActiveAt is >30s ago
  // would be treated as expired and forced to 'sleeping' by pickPosture().
  const spriteSnapshot = {
    state: card.state,
    posture: card.posture,
    hasStagedThought: false, // INV-3
    observedAt: card.lastActiveAt,
    expiresAt: now + 300_000, // 5min future — StarCard owns posture, CatSprite just renders
    confidence: 'reconciled' as const,
    sourceRef: card.sourceRef,
  };

  return (
    <div
      className="star-card-overlay"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        backdropFilter: 'blur(4px)',
      }}
      onClick={onClose}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
      role="dialog"
      aria-label={`Star card: ${card.title ?? card.threadId}`}
    >
      <div
        className="star-card"
        style={{
          position: 'relative',
          background: 'linear-gradient(135deg, rgba(20, 10, 50, 0.95), rgba(30, 15, 60, 0.95))',
          border: '1px solid rgba(200, 180, 255, 0.3)',
          borderRadius: typographyTokens.fontSizePx.base,
          padding: '24px',
          minWidth: 280,
          maxWidth: 360,
          color: '#e8e0f0',
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4), 0 0 60px rgba(120, 80, 200, 0.15)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close button */}
        <button
          onClick={onClose}
          type="button"
          style={{
            position: 'absolute',
            top: 8,
            right: 12,
            background: 'none',
            border: 'none',
            color: '#a090c0',
            cursor: 'pointer',
            fontSize: typographyTokens.fontSizePx.lg,
            lineHeight: 1,
          }}
          aria-label="Close star card"
        >
          {'✕'}
        </button>

        {/* Thread title */}
        <h3
          style={{
            margin: '0 0 16px 0',
            fontSize: typographyTokens.fontSizePx.base,
            fontWeight: 600,
            color: '#f0e8ff',
            paddingRight: 24,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {card.title ?? `Thread ${card.threadId.slice(-8)}`}
        </h3>

        {/* Cat display area */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: 100,
            marginBottom: typographyTokens.fontSizePx.base,
          }}
        >
          {hasSprite ? (
            <div style={{ transform: 'scale(0.8)', transformOrigin: 'center' }}>
              <CatSprite snapshot={spriteSnapshot} skin={skin} now={now} />
            </div>
          ) : (
            <StardustGhost catId={card.catId} state={card.state} />
          )}
        </div>

        {/* Status bar */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: typographyTokens.fontSizePx.compact,
            color: '#c0b0d8',
          }}
        >
          {/* Status dot */}
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              backgroundColor: stateColor(card.state),
              display: 'inline-block',
              flexShrink: 0,
            }}
          />
          <span>{card.catId}</span>
          <span style={{ color: '#8070a0' }}>{'·'}</span>
          <span>{postureLabel(card.posture)}</span>
        </div>

        {/* Provenance */}
        <div
          style={{
            marginTop: 8,
            fontSize: typographyTokens.fontSizePx.label,
            color: '#8070a0',
            fontFamily: 'monospace',
          }}
        >
          {card.sourceRef}
        </div>
      </div>
    </div>
  );
}

/**
 * Stardust Ghost -- CSS-only placeholder for cats without sprite assets.
 * "数据流的 telemetry 投影" -- a glowing point that pulses with activity.
 */
function StardustGhost({ catId, state }: { catId: string; state: string }) {
  const isActive = state === 'live';
  const glowSize = isActive ? 40 : 24;
  const glowAlpha = isActive ? 0.6 : 0.3;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
      }}
    >
      {/* Glow orb */}
      <div
        style={{
          width: glowSize,
          height: glowSize,
          borderRadius: '50%',
          background: `radial-gradient(circle, rgba(180, 200, 255, ${glowAlpha}) 0%, rgba(120, 140, 220, ${glowAlpha * 0.5}) 50%, transparent 70%)`,
          boxShadow: isActive ? `0 0 ${glowSize}px rgba(160, 180, 255, 0.4)` : 'none',
          transition: 'all 1s ease',
        }}
      />
      {/* Cat name label */}
      <span
        style={{
          fontSize: typographyTokens.fontSizePx.xs,
          color: '#a0b0d0',
          opacity: 0.8,
        }}
      >
        {catId}
      </span>
    </div>
  );
}
