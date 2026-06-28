'use client';

/**
 * F229 ConciergeBall — 猫本体（Layer 1）
 *
 * V1 (P0): 替换 emoji → 布偶猫 PNG sprite
 * V2 (P0): 全部颜色从 OKLCH token 来，零 Tailwind 原生色
 * V3 (P1): 方圆形底座 72×72 + 猫图 64×64 + 状态指示点
 * V4 (P1): idle 态呼吸动画（4s 慢呼吸，reduced-motion 降级）
 * V5 (P1): 八态 sprite 映射 + crossfade 过渡
 * V6 (Phase E0): PetSkinContract v0 — projection-driven sprite resolution
 * V7 (Phase E1): Atlas-based animated sprites — 9-state spritesheet animation
 *
 * 交互：
 *   collapsed → toolbar（点猫，不直接开气泡）
 *   expanded (toolbar/bubble) → collapsed（再次点猫收起）
 *
 * z-30: same layer as toolbar + bubble (below FloatingPresentationSurface z-[35])
 * aria-expanded: true when surfaceState !== 'collapsed'
 */

import type { ConciergeBallState } from '@cat-cafe/shared';
import { useConciergeStore } from '@/stores/conciergeStore';
import { type AtlasSpriteResult, resolvePetSprite } from './usePetSkin';
import { useSpriteAnimation } from './useSpriteAnimation';

interface ConciergeBallProps {
  ballState: ConciergeBallState;
}

// State → indicator dot color via CSS var (V2: zero Tailwind native color)
const STATE_DOT_COLORS: Record<ConciergeBallState, string> = {
  idle: 'var(--accent-300)',
  sleeping: 'var(--neutral-400)',
  listening: 'var(--accent-500)',
  thinking: 'var(--accent-400)',
  found: 'var(--semantic-success)',
  'needs-confirmation': 'var(--semantic-warning)',
  handoff: 'var(--semantic-info)',
  error: 'var(--semantic-critical)',
};

// State → aria-label suffix
const STATE_LABELS: Record<ConciergeBallState, string> = {
  idle: '待机中',
  sleeping: '静音',
  listening: '聆听中',
  thinking: '思考中',
  found: '发现结果',
  'needs-confirmation': '需要确认',
  handoff: '传话中',
  error: '出错了',
};

// ---------------------------------------------------------------------------
// Atlas sprite renderer (E1)
// ---------------------------------------------------------------------------

/**
 * Renders an animated sprite from an atlas spritesheet.
 * Uses <img> inside a clipping container for reliable alpha transparency.
 *
 * Why <img> instead of CSS background-image:
 *   CSS background-image + imageRendering: pixelated has known alpha compositing
 *   issues in some browser/OS combos — transparent regions render as black.
 *   An <img> element with position offset inside overflow:hidden is the most
 *   reliable cross-browser approach for spritesheet alpha.
 *
 * Display size: aspect-ratio-aware scaling.
 * Atlas cells are 192×208 (not square). To fit inside the 64×64 display area
 * while preserving aspect ratio, we height-fit: 64px height → 59px width.
 * (64 × 192/208 ≈ 59.08)
 */
function AtlasSprite({ atlas }: { atlas: AtlasSpriteResult }) {
  const { frameIndex } = useSpriteAnimation({
    frameCount: atlas.frameCount,
    frameDurations: atlas.frameDurations,
    row: atlas.row,
    cellWidth: atlas.cellWidth,
    cellHeight: atlas.cellHeight,
  });

  // Height-fit: display height = 64px, width scales proportionally
  const displayHeight = 64;
  const displayWidth = Math.round(displayHeight * (atlas.cellWidth / atlas.cellHeight));

  // Full spritesheet dimensions at display scale
  const imgWidth = displayWidth * 8;
  const imgHeight = displayHeight * 9;

  // Frame offset in display coordinates (integer math avoids rounding drift)
  const offsetX = -(frameIndex * displayWidth);
  const offsetY = -(atlas.row * displayHeight);

  return (
    <div
      aria-hidden="true"
      style={{
        width: displayWidth,
        height: displayHeight,
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      {/* biome-ignore lint/performance/noImgElement: sprite atlas, not content — Next Image optimization not applicable */}
      <img
        src={atlas.src}
        alt=""
        draggable={false}
        style={{
          position: 'absolute',
          left: offsetX,
          top: offsetY,
          width: imgWidth,
          height: imgHeight,
          maxWidth: 'none', // Override Tailwind preflight `img { max-width: 100% }`
          imageRendering: 'pixelated',
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// ConciergeBall component
// ---------------------------------------------------------------------------

export function ConciergeBall({ ballState }: ConciergeBallProps) {
  const setSurfaceState = useConciergeStore((s) => s.setSurfaceState);
  const surfaceState = useConciergeStore((s) => s.surfaceState);
  const unseenResultCount = useConciergeStore((s) => s.unseenResultCount);
  const isDragging = useConciergeStore((s) => s.isDragging);
  const setIsDragging = useConciergeStore((s) => s.setIsDragging);

  const handleClick = () => {
    // INV-P1: suppress click after drag (drag threshold ~5px in ConciergeHost)
    // isDragging stays true from onDragStop until this click handler resets it.
    if (isDragging) {
      setIsDragging(false);
      return;
    }
    // Layer 1 → Layer 2: click cat opens toolbar
    if (surfaceState === 'collapsed') {
      setSurfaceState('toolbar');
    } else {
      // Already expanded — collapse fully
      setSurfaceState('collapsed');
    }
  };

  const skin = useConciergeStore((s) => s.skin);
  const spriteResult = resolvePetSprite(ballState, skin);
  const isAtlas = typeof spriteResult !== 'string' && spriteResult.kind === 'atlas';
  const dotColor = STATE_DOT_COLORS[ballState] ?? 'var(--accent-300)';
  const stateLabel = STATE_LABELS[ballState] ?? ballState;
  const isExpanded = surfaceState !== 'collapsed';
  const isIdle = ballState === 'idle';

  return (
    <div aria-live="polite" aria-atomic="false" className="pointer-events-none">
      <button
        type="button"
        aria-label={`猫猫球 — ${stateLabel}`}
        aria-expanded={isExpanded}
        aria-haspopup="dialog"
        style={{
          // BUG-UX-1 fix: transparent background — no "狗皮膏药" opaque base.
          // Drop shadow on the button gives depth without a solid fill.
          filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.18))',
        }}
        className={[
          'pointer-events-auto',
          'relative flex items-center justify-center',
          'w-[72px] h-[72px]',
          // Squircle: border-radius 16px per design spec (§7)
          'rounded-2xl',
          // Bug fix: disable CSS transition + breathing animation during drag.
          // The transition on `transform` caused a visible "teleport then slide"
          // artifact when react-rnd's position prop updated after drag stop.
          isDragging ? '' : 'transition-transform duration-200',
          // Breathing animation only for idle state with non-atlas skins
          // (atlas skins have their own idle animation frames)
          isIdle && !isDragging && !isAtlas ? 'animate-[concierge-breathe_4s_ease-in-out_infinite]' : '',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--cafe-accent)] focus-visible:ring-offset-2',
          'select-none',
          isDragging ? 'cursor-grabbing' : 'cursor-pointer hover:scale-105',
        ].join(' ')}
        onClick={handleClick}
      >
        {/* Cat sprite — 64×64 (or aspect-ratio-aware) inside 72×72 base */}
        {isAtlas ? (
          <AtlasSprite atlas={spriteResult as AtlasSpriteResult} />
        ) : (
          // biome-ignore lint/performance/noImgElement: sprite image, not content — Next Image optimization not applicable
          <img
            src={spriteResult as string}
            alt=""
            aria-hidden="true"
            width={64}
            height={64}
            className="object-contain"
            style={{
              transition: 'opacity 300ms ease-in-out',
              imageRendering: 'pixelated',
            }}
          />
        )}

        {/* Badge dot — shows only when unseenResultCount > 0 (quiet-badge policy §3)
            role="img" lets aria-label attach to an empty visual element */}
        {unseenResultCount > 0 && (
          <span
            role="img"
            aria-label={`${unseenResultCount} 条未读结果`}
            style={{ backgroundColor: 'var(--semantic-critical)' }}
            className={[
              'absolute -top-1 -right-1',
              'w-3 h-3 rounded-full',
              // BUG-UX-1: use page background instead of removed surface-elevated
              'border-2 border-[color:var(--cafe-surface-canvas)]',
            ].join(' ')}
          />
        )}

        {/* State indicator dot (always shown, color varies by state) */}
        <span
          style={{ backgroundColor: dotColor }}
          className={[
            'absolute -bottom-1 -right-1',
            'w-3 h-3 rounded-full',
            // BUG-UX-1: use page background instead of removed surface-elevated
            'border-2 border-[color:var(--cafe-surface-canvas)]',
          ].join(' ')}
          aria-hidden="true"
        />
      </button>
    </div>
  );
}
