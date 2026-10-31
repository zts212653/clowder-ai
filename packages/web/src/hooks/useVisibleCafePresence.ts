/**
 * F258 Visible Café — Presence Adapter
 *
 * THE ONLY writer to CatPresenceSnapshot store.
 *
 * Phase A data source: reconcile poller (authoritative, sole source).
 * Socket is NOT used in Phase A — agent_message broadcasts to thread:{tid}
 * rooms only, and /starry (standalone page) cannot join arbitrary thread rooms
 * without knowing which threads to watch. Reconcile polls /api/threads which
 * returns the server-authoritative thread list with lastActiveAt.
 *
 * Phase B may add socket via dynamically joining thread rooms discovered
 * from reconcile, but Phase A reconcile-only is correct and sufficient.
 *
 * Defense Line 1: adapter is the sole write source. Render components
 * consume the store read-only via pickPosture() pure function.
 */

'use client';

import { useEffect, useRef } from 'react';
import {
  hashThreadIdToPosition,
  mapReconcileToPresence,
  threadActivityToBrightness,
} from '@/lib/visible-cafe/event-mapping';
import type { StarLight, ThreadMeta } from '@/lib/visible-cafe/presence-types';
import { MAX_STAR_LIGHTS } from '@/lib/visible-cafe/presence-types';
import { globalRenderLog } from '@/lib/visible-cafe/render-log';
import { useVisibleCafePresenceStore } from '@/stores/visible-cafe-presence';
import { apiFetch } from '@/utils/api-client';

/** Reconcile poll interval (ms). Sole realtime source in Phase A. */
const RECONCILE_INTERVAL_MS = 10_000; // 10 seconds

interface UseVisibleCafePresenceOptions {
  /** User ID for API auth cookie (socket not used in Phase A). */
  userId: string | null;
  /** Whether the adapter is enabled (e.g. page is visible). */
  enabled?: boolean;
}

/**
 * Server response shape for GET /api/threads.
 * Response is wrapped: `{ threads: ThreadListItem[] }` (NOT a bare array).
 * Inner fields match ThreadStore: `id` (not threadId), `lastActiveAt` (not lastActivity).
 * Verified against: packages/api/src/routes/threads.ts:584-592
 */
interface ThreadListItem {
  id: string;
  title: string | null;
  lastActiveAt: number;
  participants?: string[];
  /** F32-b: Thread-level cat binding. Takes priority over participants. */
  preferredCats?: string[];
}

interface ThreadListResponse {
  threads: ThreadListItem[];
}

/**
 * Adapter hook — connects reconcile poller to the presence store.
 *
 * Use in /starry page only. Phase A uses reconcile polling as the sole
 * data source (see module doc for rationale).
 */
export function useVisibleCafePresence({ userId, enabled = true }: UseVisibleCafePresenceOptions): void {
  const reconcileTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const { applyEvent, setStarLights, setThreadMetas, reset } = useVisibleCafePresenceStore.getState();

  useEffect(() => {
    if (!enabled || !userId) {
      reset();
      return;
    }

    // ── Reconcile poller (sole Phase A source) ──
    const reconcile = async () => {
      try {
        const response = await apiFetch('/api/threads?limit=30');
        if (!response.ok) return;

        // Server returns { threads: [...] } wrapper (routes/threads.ts:584-592),
        // inner objects have { id, lastActiveAt } — verified against ThreadStore + route.
        const body: ThreadListResponse = await response.json();
        const threads = body.threads;
        const now = Date.now();

        // Update star lights — only threads active in last 5 minutes
        const lights: StarLight[] = threads
          .filter((t) => now - t.lastActiveAt < 300_000)
          .slice(0, MAX_STAR_LIGHTS)
          .map((t) => {
            const pos = hashThreadIdToPosition(t.id);
            return {
              threadId: t.id,
              brightness: threadActivityToBrightness(t.lastActiveAt, now),
              x: pos.x,
              y: pos.y,
            };
          });

        setStarLights(lights);

        // Phase B: Store thread metadata for star cards
        const metas: ThreadMeta[] = threads.map((t) => ({
          threadId: t.id,
          title: t.title,
          lastActiveAt: t.lastActiveAt,
          participants: t.participants ?? [],
          preferredCats: t.preferredCats,
        }));
        setThreadMetas(metas);

        // Reconcile presence (authoritative)
        if (threads.length > 0) {
          const mapped = mapReconcileToPresence(
            threads.map((t) => ({
              threadId: t.id,
              lastActivity: t.lastActiveAt,
            })),
            now,
          );

          applyEvent({
            ...mapped,
            observedAt: now,
          });

          // Log for provenance (INV-4)
          globalRenderLog.append({
            ts: now,
            catId: 'xianxian',
            posture: mapped.posture,
            sourceRef: mapped.sourceRef,
            state: 'live',
          });
        }
      } catch {
        // Reconcile failure is non-fatal — TTL naturally decays to unknown
      }
    };

    // Initial reconcile
    reconcile();
    reconcileTimerRef.current = setInterval(reconcile, RECONCILE_INTERVAL_MS);

    // ── Cleanup ──
    return () => {
      if (reconcileTimerRef.current) {
        clearInterval(reconcileTimerRef.current);
        reconcileTimerRef.current = null;
      }
    };
  }, [userId, enabled, applyEvent, setStarLights, setThreadMetas, reset]);
}
