'use client';

/**
 * F174 D2b-2 — global callback-auth health store.
 *
 * Single source of truth for the per-cat status dot. Mounted once at app
 * level via `useCallbackAuthSnapshotProvider()` so ThreadItem participants,
 * Hub roster, and any other CatAvatar callsite can read per-cat status with
 * a tiny zustand selector — no per-callsite polling.
 *
 * 砚砚 P1 #1403: D2b-2 must be daily-visible (not buried inside D2b-3
 * dashboard). The store + selector pattern lets every CatAvatar that
 * matters become a passive consumer of one shared snapshot.
 */

import { useEffect } from 'react';
import { create } from 'zustand';
import {
  type CallbackAuthHealth,
  type CallbackAuthSnapshot,
  type CatCallbackAuthStatus,
  deriveByCat,
  useCallbackAuthSnapshot,
} from '@/hooks/useCallbackAuthSnapshot';
import { apiFetch } from '@/utils/api-client';

export interface CallbackAuthAggregate {
  byReason: Record<string, number>;
  byTool: Record<string, number>;
  totalFailures24h: number;
  /**
   * F174 D2b-2 rev3: failures within last 24h that occurred AFTER
   * lastViewedAt. Drives HubButton "unread badge" — clears to 0 when user
   * opens observability/callback-auth subtab via `markViewed()` action.
   */
  unviewedFailures24h: number;
  topReasons: Array<{ name: string; count: number }>;
  topTools: Array<{ name: string; count: number }>;
}

interface CallbackAuthState {
  /** Cloud Codex P2 #1403 (round 6): keep the raw snapshot so HubCallbackAuthPanel
   *  can render every field (recentSamples, legacyFallbackHits, etc.) WITHOUT
   *  spawning its own polling instance. Single source of truth for the panel's
   *  byCat list AND CallbackAuthCatAvatar dot status — eliminates split-snapshot
   *  staleness between roster row and avatar. */
  snapshot: CallbackAuthSnapshot | null;
  byCatStatus: Record<string, CatCallbackAuthStatus>;
  aggregate: CallbackAuthAggregate;
  /** false when snapshot fetch fails (non-owner / network) — selectors then return undefined / null defaults. */
  isAvailable: boolean;
  /** Most recent fetch error (null on success). Surfaced to panel so it can render an error banner. */
  lastError: string | null;
  /**
   * Cloud Codex P2 #1425 round 4: server-authoritative cutoff watermark from
   * our most recent successful mark-viewed POST. Snapshots whose
   * `lastViewedAt` is < this value are stale (they reflect server state from
   * before our mark) — applySnapshot patches their `unviewedFailures24h`
   * locally so the badge doesn't briefly re-appear when a 30s poll started
   * before the POST resolves afterward. Cleared back to null once a snapshot
   * arrives with `lastViewedAt >= cutoff` (server caught up).
   */
  pendingMarkViewedCutoff: number | null;
  applySnapshot: (snapshot: CallbackAuthSnapshot | null, error?: string | null) => void;
  /**
   * F174 D2b-2 rev3: POST /api/debug/callback-auth/mark-viewed. Called when
   * user opens observability/callback-auth subtab. On success, optimistically
   * zeros local `unviewedFailures24h` so badge clears immediately (next poll
   * will confirm with server-authoritative value).
   */
  markViewed: () => Promise<void>;
}

const EMPTY_AGGREGATE: CallbackAuthAggregate = {
  byReason: {},
  byTool: {},
  totalFailures24h: 0,
  unviewedFailures24h: 0,
  topReasons: [],
  topTools: [],
};

function topN(record: Record<string, number>, n = 5): Array<{ name: string; count: number }> {
  return Object.entries(record)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name, count]) => ({ name, count }));
}

export function buildAggregate(snapshot: CallbackAuthSnapshot): CallbackAuthAggregate {
  const r24 = snapshot.recent24h;
  // F174 D2b-2 rev3: server-authoritative unviewedFailures24h; older API
  // versions without the field default to totalFailures24h (no regression for
  // pre-rev3 deployments — badge keeps showing all 24h failures).
  const unviewed = snapshot.unviewedFailures24h ?? r24.totalFailures;
  return {
    byReason: { ...r24.byReason },
    byTool: { ...r24.byTool },
    totalFailures24h: r24.totalFailures,
    unviewedFailures24h: unviewed,
    topReasons: topN(r24.byReason),
    topTools: topN(r24.byTool),
  };
}

export const useCallbackAuthStore = create<CallbackAuthState>((set, get) => ({
  snapshot: null,
  byCatStatus: {},
  aggregate: EMPTY_AGGREGATE,
  isAvailable: false,
  lastError: null,
  pendingMarkViewedCutoff: null,
  applySnapshot: (snapshot, error) => {
    if (error) {
      set({ isAvailable: false, lastError: error });
      return;
    }
    if (!snapshot) return;

    let aggregate = buildAggregate(snapshot);

    // Cloud Codex P2 #1425 round 4: a poll that started BEFORE markViewed POST
    // and resolves AFTER would otherwise overwrite our optimistic clear with
    // pre-view server state, making the badge briefly re-appear. Detect via
    // server's lastViewedAt: if snapshot's value is older than our pending
    // cutoff, this snapshot is stale — patch unviewedFailures24h from local
    // recentSamples filtered against our cutoff instead.
    const cutoff = get().pendingMarkViewedCutoff;
    let nextCutoff: number | null = cutoff;
    if (cutoff !== null) {
      const snapLastViewed = snapshot.lastViewedAt ?? 0;
      if (snapLastViewed >= cutoff) {
        // Server has caught up — snapshot is authoritative, clear the cutoff
        nextCutoff = null;
      } else {
        // Stale snapshot — preserve optimistic clear by recomputing locally.
        // Use `>=` to mirror server's same-ms safe-side bias (Cloud P2 round 5).
        aggregate = {
          ...aggregate,
          unviewedFailures24h: snapshot.recentSamples.filter((s) => s.at >= cutoff).length,
        };
      }
    }

    set({
      snapshot,
      byCatStatus: deriveByCat(snapshot),
      aggregate,
      isAvailable: true,
      lastError: null,
      pendingMarkViewedCutoff: nextCutoff,
    });
  },
  markViewed: async () => {
    try {
      // F174 D2b-1 alpha #6 fix: 铲屎官 reported "小红点点进去看板没消除".
      //
      // Original Cloud P2 round 1 design: pass viewedUpTo = snapshot's
      // server-side "as of" timestamp to avoid ack'ing failures user hasn't
      // seen (snapshot 30s lag). But this was over-engineered against the
      // real user mental model: opening the panel = "I've reviewed the
      // current 24h state, ack everything to now".
      //
      // The "user might miss failures arriving between snapshot and now"
      // concern is theoretical — those failures will surface on next poll
      // (server-side counter still increments), and the user just opened
      // the panel deliberately to look at callback auth state. Treating
      // panel-open as full-state ack is the simpler, more intuitive model.
      //
      // Trade-off accepted: failures arriving in the snapshot-to-now gap
      // get auto-ack'd. They show up in next-poll'd snapshot's recentSamples
      // (history preserved) but don't trigger an unread-badge re-appear.
      // For active-failure scenarios, badge will re-populate on next failure
      // anyway. For idle-cat scenarios (alpha #6 root case), badge cleanly
      // clears on panel open and stays cleared.
      //
      // Server defaults to Date.now() when no body provided.
      const res = await apiFetch('/api/debug/callback-auth/mark-viewed', {
        method: 'POST',
      });
      if (!res.ok) return; // silently no-op on error — badge will catch up on next poll
      // Cloud Codex P2 #1425 round 2: don't blindly zero — derive optimistic
      // unviewed from snapshot using SERVER's authoritative lastViewedAt
      // returned in the response. recentSamples is the 100-most-recent in 24h;
      // counting those still > server's cutoff gives the correct local state
      // for failures present in the snapshot.
      //
      // Cloud Codex P2 #1425 round 3: re-read snapshot from store AFTER await,
      // not the captured `initialSnap`. A poll may have applied a fresher
      // snapshot while the POST was in flight (common when opening panel near
      // a poll tick or under slow network). Using the latest snapshot
      // recomputes the badge correctly instead of overwriting fresh aggregate
      // with stale-snapshot data.
      const json = (await res.json().catch(() => null)) as { lastViewedAt?: number } | null;
      const serverCutoff = typeof json?.lastViewedAt === 'number' ? json.lastViewedAt : Date.now();
      const currentCutoff = get().pendingMarkViewedCutoff ?? 0;
      // Cloud Codex P1 #1425 round 6: monotonic max — overlapping markViewed
      // responses out of order must NOT regress the cutoff watermark.
      const effectiveCutoff = Math.max(currentCutoff, serverCutoff);
      const latestSnap = get().snapshot;
      // alpha #6 fix: with viewedUpTo defaulting to server `now`, all samples
      // in current snapshot are by definition <= server cutoff (they happened
      // before the POST). Optimistic clear to 0 is correct; any newer failures
      // arriving after the POST will surface on next poll naturally (server
      // counter > effectiveCutoff). Filter retained for defensive consistency
      // with applySnapshot stale-snapshot patch (Cloud P2 round 4).
      const optimisticUnviewed = latestSnap
        ? latestSnap.recentSamples.filter((s) => s.at >= effectiveCutoff).length
        : 0;
      const current = get().aggregate;
      // Cloud Codex P2 #1425 round 4: persist cutoff so applySnapshot can
      // detect and patch stale poll responses that arrive after this POST.
      set({
        aggregate: { ...current, unviewedFailures24h: optimisticUnviewed },
        pendingMarkViewedCutoff: effectiveCutoff,
      });
    } catch {
      /* network error — badge unchanged, will sync on next successful poll */
    }
  },
}));

/**
 * Mount-once provider hook — internal use. Prefer `<CallbackAuthSnapshotMount />`
 * over calling this directly: the hook owns useState + re-renders on every
 * fetch tick, so embedding it in a component re-renders that component's whole
 * subtree. Cloud Codex P2 #1403 (round 10): chat layout used to call this
 * directly, causing every 30s ChatContainer + thread tree to re-render.
 */
export function useCallbackAuthSnapshotProvider(options?: { enabled?: boolean; pollIntervalMs?: number }): void {
  const { snapshot, error } = useCallbackAuthSnapshot(options);
  const apply = useCallbackAuthStore((s) => s.applySnapshot);
  useEffect(() => {
    apply(snapshot, error);
  }, [snapshot, error, apply]);
}

/**
 * Render-isolated provider component. Mount once at chat layout level next
 * to ChatContainer. Returns null so re-renders on every poll tick stay
 * confined to this leaf — ChatContainer + thread tree never re-render
 * because of callback-auth polling.
 */
export function CallbackAuthSnapshotMount(props: { enabled?: boolean; pollIntervalMs?: number } = {}): null {
  useCallbackAuthSnapshotProvider(props);
  return null;
}

/** Per-cat selector. Returns undefined when no data (cat had no callback-auth events in 24h). */
export function useCallbackAuthByCat(catId: string | null | undefined): CatCallbackAuthStatus | undefined {
  return useCallbackAuthStore((s) => (catId ? s.byCatStatus[catId] : undefined));
}

/** Aggregate selector for hover popover content. */
export function useCallbackAuthAggregate(): CallbackAuthAggregate {
  return useCallbackAuthStore((s) => s.aggregate);
}

/**
 * F174 D2b-2 rev3: action selector for "mark callback-auth as viewed" — used
 * by HubCallbackAuthPanel onMount to clear the HubButton unread badge when
 * user opens the subtab. Stable reference (zustand action), safe to depend on
 * in useEffect.
 */
export function useCallbackAuthMarkViewed(): () => Promise<void> {
  return useCallbackAuthStore((s) => s.markViewed);
}

/** Whether the store has at least one successful snapshot. */
export function useCallbackAuthAvailable(): boolean {
  return useCallbackAuthStore((s) => s.isAvailable);
}

/** Most recent fetch error (null on success). Used by HubCallbackAuthPanel banner. */
export function useCallbackAuthError(): string | null {
  return useCallbackAuthStore((s) => s.lastError);
}

/** Raw snapshot — Cloud Codex P2 #1403 unified source for HubCallbackAuthPanel. */
export function useCallbackAuthRawSnapshot(): CallbackAuthSnapshot | null {
  return useCallbackAuthStore((s) => s.snapshot);
}

export type { CallbackAuthHealth };
