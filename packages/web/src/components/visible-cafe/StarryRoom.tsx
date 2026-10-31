/**
 * F258 Visible Cafe -- StarryRoom
 *
 * Main composition: background scene + CatSprite + StarWindow + StarCard.
 * Defense Line 1: zero state. Reads store snapshot, passes to children.
 *
 * "主星=家=下班" -- the room is a cozy planet interior, cat sleeps peacefully,
 * work expression lives in the star window lights only.
 *
 * Phase B: Stars are clickable -- opens StarCard showing per-thread cat.
 */

'use client';

import Image from 'next/image';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SkinManifest } from '@/lib/visible-cafe/asset-config';
import { SCENES } from '@/lib/visible-cafe/asset-config';
import { deriveStarCardSnapshot } from '@/lib/visible-cafe/event-mapping';
import type { QuietHoursConfig } from '@/lib/visible-cafe/presence-types';
import { DEFAULT_QUIET_HOURS } from '@/lib/visible-cafe/presence-types';
import { useVisibleCafePresenceStore } from '@/stores/visible-cafe-presence';
import { CatSprite, isQuietHours } from './CatSprite';
import { ProvenanceOverlay } from './ProvenanceOverlay';
import { StarCard } from './StarCard';
import { StarWindow } from './StarWindow';

interface StarryRoomProps {
  skin: SkinManifest;
  quietHours?: QuietHoursConfig;
  onCatHomeOpen?: () => void;
}

/**
 * Coordinates are normalized against the canonical 1672×941 scene, not the
 * browser viewport. Keeping the scene contained makes this anchor stable on
 * desktop and iPad instead of drifting onto the bookshelf when `cover` crops.
 */
const MAIN_PLANET_SCENE_ASPECT_RATIO = '1672 / 941';
const MAIN_PLANET_SCENE_MAX_WIDTH = '177.68vh';
const STAR_WINDOW_FRAME = {
  top: '3%',
  left: '0.75%',
  width: '27.5%',
  height: '47%',
} as const;

export function StarryRoom({ skin, quietHours = DEFAULT_QUIET_HOURS, onCatHomeOpen }: StarryRoomProps) {
  const snapshot = useVisibleCafePresenceStore((s) => s.snapshot);
  const starLights = useVisibleCafePresenceStore((s) => s.starLights);
  const tick = useVisibleCafePresenceStore((s) => s.tick);
  const threadMetas = useVisibleCafePresenceStore((s) => s.threadMetas);
  const selectedStarThreadId = useVisibleCafePresenceStore((s) => s.selectedStarThreadId);
  const selectStar = useVisibleCafePresenceStore((s) => s.selectStar);

  const [now, setNow] = useState(() => Date.now());
  const [showProvenance, setShowProvenance] = useState(false);
  const [quiet, setQuiet] = useState(() => isQuietHours(new Date(), quietHours));
  const tickIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Clock tick -- drives state transitions + animation timing.
  // Re-evaluates quiet hours every tick so boundary crossings (09:00/18:00)
  // take effect without waiting for a remount (P2 fix from review).
  useEffect(() => {
    const intervalMs = quiet ? 1000 : 500; // Slower tick in quiet hours

    tickIntervalRef.current = setInterval(() => {
      const t = Date.now();
      setNow(t);
      tick(t);

      // Re-evaluate quiet hours on every tick -- boundary crossings
      // flip this state, which re-runs this effect with new interval
      const nowQuiet = isQuietHours(new Date(t), quietHours);
      setQuiet(nowQuiet);
    }, intervalMs);

    return () => {
      if (tickIntervalRef.current) {
        clearInterval(tickIntervalRef.current);
      }
    };
  }, [tick, quietHours, quiet]);

  const handleCatClick = useCallback(() => {
    if (onCatHomeOpen) {
      onCatHomeOpen();
      return;
    }
    setShowProvenance((prev) => !prev);
  }, [onCatHomeOpen]);

  // Phase B: star click handler
  const handleStarClick = useCallback(
    (threadId: string) => {
      selectStar(threadId);
    },
    [selectStar],
  );

  const handleStarCardClose = useCallback(() => {
    selectStar(null);
  }, [selectStar]);

  // Phase B: derive star card snapshot from thread meta
  const starCardSnapshot = useMemo(() => {
    if (!selectedStarThreadId) return null;
    const meta = threadMetas.get(selectedStarThreadId);
    if (!meta) return null;
    return deriveStarCardSnapshot(meta, now);
  }, [selectedStarThreadId, threadMetas, now]);

  return (
    <div
      className="starry-room"
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        backgroundColor: '#1a0a2e', // Deep purple fallback
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {/* Ambient fill keeps the room immersive while the canonical scene stays uncropped. */}
      <Image
        src={SCENES.mainPlanetBg}
        alt=""
        aria-hidden="true"
        fill
        sizes="100vw"
        priority
        style={{
          objectFit: 'cover',
          opacity: 0.28,
          filter: 'blur(18px) brightness(0.55) saturate(0.8)',
          transform: 'scale(1.06)',
        }}
        draggable={false}
      />

      <div
        data-testid="main-planet-stage"
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: MAIN_PLANET_SCENE_MAX_WIDTH,
          maxHeight: '100%',
          aspectRatio: MAIN_PLANET_SCENE_ASPECT_RATIO,
          overflow: 'hidden',
          boxShadow: '0 20px 80px rgba(8, 3, 24, 0.55)',
        }}
      >
        {/* Canonical scene: never cropped, so every overlay shares one coordinate system. */}
        <Image
          src={SCENES.mainPlanetBg}
          alt="猫猫主星的客厅，左侧拱窗外是平行世界的星球"
          fill
          sizes="100vw"
          priority
          style={{
            objectFit: 'fill',
          }}
          draggable={false}
        />

        {/* Activity planets are anchored to the painted arch window. */}
        <div
          data-testid="star-window-anchor"
          style={{
            position: 'absolute',
            ...STAR_WINDOW_FRAME,
          }}
        >
          <StarWindow starLights={starLights} isQuiet={quiet} onStarClick={handleStarClick} />
        </div>

        {/* Cat sprite (centered on the rug area) */}
        <div
          style={{
            position: 'absolute',
            bottom: '15%',
            left: '50%',
            transform: 'translateX(-50%)',
          }}
        >
          <CatSprite snapshot={snapshot} skin={skin} now={now} onClick={handleCatClick} quietHours={quietHours} />
        </div>
      </div>

      {onCatHomeOpen && (
        <button
          type="button"
          className="absolute bottom-4 left-4 z-10 rounded-full border border-[var(--console-border-soft)] bg-[var(--console-overlay-control)] px-3 py-1.5 text-xs text-[var(--overlay-fg)] backdrop-blur-sm transition-opacity hover:opacity-80"
          onClick={() => setShowProvenance((current) => !current)}
        >
          状态来源
        </button>
      )}

      {/* Provenance overlay (AC-A3: click cat -> show source chain) */}
      {showProvenance && <ProvenanceOverlay snapshot={snapshot} onClose={() => setShowProvenance(false)} />}

      {/* Phase B: Star card (click star -> show per-thread cat) */}
      {starCardSnapshot && <StarCard card={starCardSnapshot} skin={skin} now={now} onClose={handleStarCardClose} />}
    </div>
  );
}
