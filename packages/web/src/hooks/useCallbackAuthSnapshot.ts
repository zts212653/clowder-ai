'use client';

/**
 * F174 D2b-2 + D2b-3 — fetch + poll the owner-gated callback auth snapshot.
 *
 * Backed by GET `/api/debug/callback-auth` (owner-gated, returns 401/403 for
 * non-owner sessions). Caller can opt out of polling via `enabled = false`
 * (e.g. when component is unmounted, or the user isn't the owner). 30s cadence
 * matches HubObservabilityTab Overview/Health tabs.
 *
 * Returns derived `byCat` map (cat → status + counts) for the D2b-2 status dot
 * so callers don't recompute thresholds.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

export interface CallbackAuthSnapshot {
  reasonCounts: Record<string, number>;
  toolCounts: Record<string, number>;
  byCat: Record<string, number>;
  recentSamples: Array<{ at: number; reason: string; tool: string; catId?: string }>;
  totalFailures: number;
  startedAt: number;
  uptimeMs: number;
  recent24h: {
    totalFailures: number;
    byReason: Record<string, number>;
    byTool: Record<string, number>;
    byCat: Record<string, number>;
  };
  legacyFallbackHits?: { byTool: Record<string, number>; total: number };
  /** F174 D2b-2 rev3: timestamp of last `mark-viewed`. 0 if never viewed. */
  lastViewedAt?: number;
  /**
   * F174 D2b-2 rev3: count of failures within last 24h that occurred AFTER
   * lastViewedAt. Drives HubButton "unread badge" — clears to 0 when user
   * opens observability/callback-auth subtab.
   */
  unviewedFailures24h?: number;
}

export type CallbackAuthHealth = 'healthy' | 'degraded' | 'broken' | 'unknown';

/**
 * 24h failure thresholds → health status.
 * Tunable; current values match D2b-2 spec heuristic ("a couple = degraded,
 * many = broken"). When per-cat call totals become available we should switch
 * to a 401-rate based bucket.
 */
const DEGRADED_THRESHOLD = 1;
const BROKEN_THRESHOLD = 6;

export interface CatCallbackAuthStatus {
  status: CallbackAuthHealth;
  failures24h: number;
}

function deriveStatus(failures24h: number): CallbackAuthHealth {
  if (failures24h >= BROKEN_THRESHOLD) return 'broken';
  if (failures24h >= DEGRADED_THRESHOLD) return 'degraded';
  return 'healthy';
}

export function deriveByCat(snapshot: CallbackAuthSnapshot | null): Record<string, CatCallbackAuthStatus> {
  if (!snapshot) return {};
  const out: Record<string, CatCallbackAuthStatus> = {};
  for (const [catId, failures24h] of Object.entries(snapshot.recent24h.byCat)) {
    out[catId] = { status: deriveStatus(failures24h), failures24h };
  }
  return out;
}

export interface UseCallbackAuthSnapshotResult {
  snapshot: CallbackAuthSnapshot | null;
  byCat: Record<string, CatCallbackAuthStatus>;
  loading: boolean;
  /** null when ok, message when fetch failed (e.g. 'forbidden', 'network'). */
  error: string | null;
  refetch: () => void;
}

interface Options {
  /** Disable polling (e.g. component unmounted, owner gate failed). */
  enabled?: boolean;
  /** Polling interval, ms. Default 30s. Pass 0 to disable interval. */
  pollIntervalMs?: number;
}

/**
 * Cloud Codex evolution (#1403 rounds 2/3/8):
 *   round 2: stop polling on 401/403 ("non-owner shouldn't hammer endpoint")
 *   round 3: backoff instead — owner promotion couldn't recover
 *   round 8: backoff still wastes traffic for the common non-owner case
 * Final: STOP on 401/403. We accept "owner promotion needs page reload" as
 * an edge case (single user setup; promotion is admin-only via env var) in
 * exchange for zero wasted /api/debug/callback-auth traffic from non-owner
 * sessions in the chat-layout-mounted provider.
 */

export function useCallbackAuthSnapshot(options: Options = {}): UseCallbackAuthSnapshotResult {
  const enabled = options.enabled ?? true;
  const pollIntervalMs = options.pollIntervalMs ?? 30_000;

  const [snapshot, setSnapshot] = useState<CallbackAuthSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  // 砚砚 P1 #1403: generation token guards against the race where an
  // in-flight fetch resolves AFTER unmount / enabled=false and re-arms a
  // timer. Each effect run bumps the generation; fetchAndReschedule checks
  // it after every await before touching state or scheduling next.
  const generationRef = useRef(0);
  // Cloud Codex P2 #1403 (round 8): per-session auth-blocked latch. Once any
  // request returns 401/403, we stop polling permanently for this hook
  // instance — non-owner tabs go quiet immediately. refetch() resets the
  // latch so a manual retry button can recover; an owner promotion mid-session
  // requires a page reload (acceptable trade-off given single-user setup).
  const authBlockedRef = useRef(false);

  const fetchAndReschedule = useCallback(
    async (generation: number) => {
      try {
        const res = await apiFetch('/api/debug/callback-auth');
        if (generationRef.current !== generation) return; // unmounted / disabled mid-flight
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          if (generationRef.current !== generation) return;
          setError(body.error ?? `HTTP ${res.status}`);
          if (res.status === 401 || res.status === 403) {
            authBlockedRef.current = true;
          }
        } else {
          const data = (await res.json()) as CallbackAuthSnapshot;
          if (generationRef.current !== generation) return;
          setSnapshot(data);
          setError(null);
          authBlockedRef.current = false;
        }
      } catch (err) {
        if (generationRef.current !== generation) return;
        setError(err instanceof Error ? err.message : 'fetch failed');
      } finally {
        if (generationRef.current === generation) {
          setLoading(false);
        }
      }
      // Reschedule next poll unless: (a) we've been invalidated by cleanup, OR
      // (b) the latch has flipped — non-owner sessions then sit idle.
      if (generationRef.current !== generation) return;
      if (authBlockedRef.current) return;
      if (timerRef.current) clearTimeout(timerRef.current);
      if (pollIntervalMs > 0) {
        timerRef.current = setTimeout(() => void fetchAndReschedule(generation), pollIntervalMs);
      }
    },
    [pollIntervalMs],
  );

  useEffect(() => {
    if (!enabled) {
      generationRef.current += 1; // invalidate any in-flight fetch
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = undefined;
      return;
    }
    // Reset auth latch on (re)mount so a recovery from disabled→enabled starts fresh.
    authBlockedRef.current = false;
    generationRef.current += 1;
    const myGeneration = generationRef.current;
    void fetchAndReschedule(myGeneration);
    return () => {
      generationRef.current += 1; // invalidate on cleanup so any in-flight fetch becomes a no-op
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = undefined;
    };
  }, [enabled, fetchAndReschedule]);

  return {
    snapshot,
    byCat: deriveByCat(snapshot),
    loading,
    error,
    /** Manual refetch — also clears the auth-blocked latch so a forced retry can recover. */
    refetch: () => {
      authBlockedRef.current = false;
      void fetchAndReschedule(generationRef.current);
    },
  };
}
