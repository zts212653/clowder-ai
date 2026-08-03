/**
 * F258 Visible Café — CatPresenceSnapshot Store
 *
 * State machine (§2a of implementation plan):
 *   unknown ──socket/reconcile──▶ live
 *   live ──────half-TTL──────────▶ stale
 *   live ──────TTL-expired───────▶ unknown
 *   stale ─────socket/reconcile──▶ live
 *   stale ─────TTL-expired───────▶ unknown
 *
 * ONLY the adapter (useVisibleCafePresence) calls these actions.
 * Render components have ZERO write access (Defense Line 1).
 */

import { create } from 'zustand';
import type {
  CatPosture,
  CatPresenceSnapshot,
  ConfidenceLevel,
  StarLight,
  ThreadMeta,
} from '@/lib/visible-cafe/presence-types';
import { createInitialSnapshot, MAX_STAR_LIGHTS, PRESENCE_TTL_MS } from '@/lib/visible-cafe/presence-types';

export interface VisibleCafePresenceState {
  /** Cat presence snapshot — the single source of truth for rendering. */
  snapshot: CatPresenceSnapshot;

  /** Active star lights (thread activity indicators). */
  starLights: StarLight[];

  /** Phase B: Thread metadata for star card rendering. */
  threadMetas: Map<string, ThreadMeta>;

  /** Phase B: Currently selected star threadId (null = no card open). */
  selectedStarThreadId: string | null;

  // ── Adapter-only actions (Defense Line 1: render must not call these) ──

  /** Process an incoming socket/reconcile event. Rejects out-of-order events. */
  applyEvent: (event: {
    posture: CatPosture;
    hasStagedThought: boolean;
    observedAt: number;
    confidence: ConfidenceLevel;
    sourceRef: string;
  }) => void;

  /** Tick the clock — transitions live→stale→unknown based on TTL. */
  tick: (now: number) => void;

  /** Handle socket disconnect — start TTL countdown (don't immediately transition). */
  onSocketDisconnect: () => void;

  /** Update star lights from thread activity data. */
  setStarLights: (lights: StarLight[]) => void;

  /** Phase B: Update thread metadata from reconcile. */
  setThreadMetas: (metas: ThreadMeta[]) => void;

  /** Phase B: Select/deselect a star for card display. */
  selectStar: (threadId: string | null) => void;

  /** Reset to initial unknown state. */
  reset: () => void;
}

export const useVisibleCafePresenceStore = create<VisibleCafePresenceState>((set, get) => ({
  snapshot: createInitialSnapshot(),
  starLights: [],
  threadMetas: new Map(),
  selectedStarThreadId: null,

  applyEvent: (event) => {
    const current = get().snapshot;

    // Out-of-order guard: reject events older than current observation.
    if (event.observedAt <= current.observedAt) {
      return;
    }

    // Reconcile (authoritative) always wins over socket.
    // Socket events are also accepted when they're newer.
    set({
      snapshot: {
        state: 'live',
        posture: event.posture,
        hasStagedThought: event.hasStagedThought,
        observedAt: event.observedAt,
        expiresAt: event.observedAt + PRESENCE_TTL_MS,
        confidence: event.confidence,
        sourceRef: event.sourceRef,
      },
    });
  },

  tick: (now) => {
    const current = get().snapshot;
    if (current.state === 'unknown') return;

    if (now >= current.expiresAt) {
      // TTL expired → unknown
      set({
        snapshot: {
          ...current,
          state: 'unknown',
        },
      });
    } else if (current.state === 'live' && now >= current.observedAt + (current.expiresAt - current.observedAt) / 2) {
      // Half-TTL passed → stale
      set({
        snapshot: {
          ...current,
          state: 'stale',
        },
      });
    }
  },

  onSocketDisconnect: () => {
    // Don't immediately transition — let TTL handle it.
    // The tick() will naturally move live→stale→unknown as time passes.
    // This is a no-op; the adapter stops refreshing, and TTL does the rest.
  },

  setStarLights: (lights) => {
    // INV-7: cap at MAX_STAR_LIGHTS
    set({
      starLights: lights.slice(0, MAX_STAR_LIGHTS),
    });
  },

  setThreadMetas: (metas) => {
    const map = new Map<string, ThreadMeta>();
    for (const m of metas) {
      map.set(m.threadId, m);
    }
    set({ threadMetas: map });
  },

  selectStar: (threadId) => {
    set({ selectedStarThreadId: threadId });
  },

  reset: () => {
    set({
      snapshot: createInitialSnapshot(),
      starLights: [],
      threadMetas: new Map(),
      selectedStarThreadId: null,
    });
  },
}));
