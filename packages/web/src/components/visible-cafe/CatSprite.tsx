/**
 * F258 Visible Café — CatSprite
 *
 * 🚫 Defense Line 1: THIS LAYER HAS ZERO STATE.
 * Posture = pickPosture(snapshot, now) pure function.
 * No store writes, no local state copies, no side-effect posture logic.
 *
 * "表情是 telemetry 不是演技" — no animation without state source.
 * Cat sits idle rather than performing.
 */

'use client';

import { useCallback, useEffect, useRef } from 'react';
import type { SkinManifest, SkinRowDef } from '@/lib/visible-cafe/asset-config';
import { VISIBLE_CAFE_ASSET_BASE } from '@/lib/visible-cafe/asset-config';
import type { CatPosture, CatPresenceSnapshot, QuietHoursConfig } from '@/lib/visible-cafe/presence-types';
import { DEFAULT_QUIET_HOURS, QUIET_TICK_INTERVAL_MS, TICK_INTERVAL_MS } from '@/lib/visible-cafe/presence-types';

// ── pickPosture: THE pure function (INV-1) ──

/**
 * Determine which posture to render. Pure function — same inputs, same output.
 * INV-1: render posture = pickPosture(snapshot, now), no component state.
 * INV-2: expired snapshot → sleeping (never renders live posture past expiry).
 */
export function pickPosture(snapshot: CatPresenceSnapshot, now: number): CatPosture {
  // Unknown or expired → always sleeping
  if (snapshot.state === 'unknown' || now >= snapshot.expiresAt) {
    return 'sleeping';
  }
  return snapshot.posture;
}

/**
 * Determine opacity. Unknown → 50%, live/stale → 100%.
 */
export function pickOpacity(snapshot: CatPresenceSnapshot, now: number): number {
  if (snapshot.state === 'unknown' || now >= snapshot.expiresAt) {
    return 0.5;
  }
  return 1;
}

/**
 * Check if current time is within quiet hours (INV-5).
 */
export function isQuietHours(now: Date, config: QuietHoursConfig = DEFAULT_QUIET_HOURS): boolean {
  const hour = now.getHours();
  if (config.startHour <= config.endHour) {
    // e.g. 9-18: quiet during 9..17
    return hour >= config.startHour && hour < config.endHour;
  }
  // e.g. 22-6: quiet during 22..23 or 0..5
  return hour >= config.startHour || hour < config.endHour;
}

// ── Component ──

interface CatSpriteProps {
  snapshot: CatPresenceSnapshot;
  skin: SkinManifest;
  now: number;
  onClick?: () => void;
  quietHours?: QuietHoursConfig;
}

export function CatSprite({ snapshot, skin, now, onClick, quietHours = DEFAULT_QUIET_HOURS }: CatSpriteProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameIndexRef = useRef(0);
  const imageCache = useRef<Map<string, HTMLImageElement>>(new Map());

  // Pure function calls — no state
  const posture = pickPosture(snapshot, now);
  const opacity = pickOpacity(snapshot, now);

  const rowDef: SkinRowDef | undefined = skin.rows[posture];
  const fallbackRowDef: SkinRowDef = skin.rows.idle ?? skin.rows.sleeping;
  const activeRow = rowDef ?? fallbackRowDef;
  const activePosture = rowDef ? posture : 'idle';

  // Load and cache row image
  const getImage = useCallback(
    (src: string): HTMLImageElement | null => {
      const cached = imageCache.current.get(src);
      if (cached?.complete) return cached;
      if (cached) return null; // loading

      const img = new Image();
      img.src = `${VISIBLE_CAFE_ASSET_BASE}/skins/xianxian/${src}`;
      img.onload = () => {
        imageCache.current.set(src, img);
        // Trigger repaint
        drawFrame();
      };
      imageCache.current.set(src, img);
      return null;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const drawFrame = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const img = getImage(activeRow.src);
    if (!img) return;

    const { width, height } = skin.cell;
    const frameIdx = frameIndexRef.current % activeRow.frames;

    ctx.clearRect(0, 0, width, height);
    ctx.globalAlpha = opacity;
    ctx.drawImage(
      img,
      frameIdx * width,
      0,
      width,
      height, // source rect
      0,
      0,
      width,
      height, // dest rect
    );
    ctx.globalAlpha = 1;
  }, [activeRow, skin.cell, opacity, getImage]);

  // Animation tick loop
  useEffect(() => {
    const quiet = isQuietHours(new Date(), quietHours);
    const tickMs = quiet ? QUIET_TICK_INTERVAL_MS : TICK_INTERVAL_MS;

    let elapsed = 0;
    let currentFrameDuration = activeRow.frameDurations[frameIndexRef.current % activeRow.frames] ?? 500;

    const interval = setInterval(() => {
      elapsed += tickMs;
      if (elapsed >= currentFrameDuration) {
        elapsed = 0;
        frameIndexRef.current = (frameIndexRef.current + 1) % activeRow.frames;
        currentFrameDuration = activeRow.frameDurations[frameIndexRef.current % activeRow.frames] ?? 500;
      }
      drawFrame();
    }, tickMs);

    // Initial draw
    drawFrame();

    return () => clearInterval(interval);
  }, [activePosture, activeRow, drawFrame, quietHours]);

  // Reset frame index when posture changes
  useEffect(() => {
    frameIndexRef.current = 0;
  }, [activePosture]);

  return (
    <canvas
      ref={canvasRef}
      width={skin.cell.width}
      height={skin.cell.height}
      onClick={onClick}
      style={{
        cursor: onClick ? 'pointer' : 'default',
        imageRendering: 'pixelated',
        // anchorOffsetY applied via transform in parent
        transform: `translateY(${activeRow.anchorOffsetY}px)`,
      }}
      aria-label={`Cat sprite: ${activePosture}`}
    />
  );
}
