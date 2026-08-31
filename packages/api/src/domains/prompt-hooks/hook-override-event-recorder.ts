/**
 * Event recording and listing for HookOverrideStore.
 * Extracted to keep HookOverrideStore under the 350-line limit.
 */

import type { HookOverride, HookOverrideSource, OverrideAction, OverrideChangeEvent } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';

// ---------------------------------------------------------------------------
// Redis key helpers (shared with HookOverrideStore)
// ---------------------------------------------------------------------------

export const EVENT_ZSET = (ws: string) => `hook-override-events:${ws}`;
export const EVENT_KEY = (ws: string, id: string) => `hook-override-event:${ws}:${id}`;

// ---------------------------------------------------------------------------
// Event recorder
// ---------------------------------------------------------------------------

export class HookOverrideEventRecorder {
  /** Monotonic counter for event ID uniqueness within a process. */
  private eventSeq = 0;

  constructor(private readonly redis: RedisClient) {}

  async record(
    workspaceId: string,
    hookId: string,
    action: OverrideAction,
    source: HookOverrideSource,
    actorId: string,
    reason?: string,
    contentVersion?: number,
    epochVersion?: number,
  ): Promise<void> {
    const timestamp = Date.now();
    const seq = this.eventSeq++;
    const eventId = `${timestamp}-${String(seq).padStart(6, '0')}-${hookId}-${action}`;
    const event: OverrideChangeEvent = {
      eventId,
      hookId,
      workspaceId,
      action,
      source,
      timestamp,
      actorId,
      ...(reason ? { reason } : {}),
      ...(contentVersion != null ? { contentVersion } : {}),
      ...(epochVersion != null ? { epochVersion } : {}),
    };
    // TTL=0: audit events are permanent (Iron Law 5, sol P1-2 fix)
    await this.redis.set(EVENT_KEY(workspaceId, eventId), JSON.stringify(event));
    await this.redis.zadd(EVENT_ZSET(workspaceId), timestamp, eventId);
  }

  async list(
    workspaceId: string,
    opts?: { limit?: number; since?: number; until?: number },
  ): Promise<OverrideChangeEvent[]> {
    const since = opts?.since ?? 0;
    const until = opts?.until ?? '+inf';
    const limit = opts?.limit ?? 50;
    const eventIds = await this.redis.zrangebyscore(EVENT_ZSET(workspaceId), since, until, 'LIMIT', 0, limit);
    const events: OverrideChangeEvent[] = [];
    for (const id of eventIds) {
      const raw = await this.redis.get(EVENT_KEY(workspaceId, id));
      if (!raw) continue;
      try {
        events.push(JSON.parse(raw) as OverrideChangeEvent);
      } catch {
        /* skip */
      }
    }
    return events;
  }
}

// ---------------------------------------------------------------------------
// Reconciliation (pure function — decoupled from store class)
// ---------------------------------------------------------------------------

export type ManifestLookupFn = (hookId: string) => { disableable?: boolean; safetyTier?: string } | undefined;

/**
 * Reconcile a single override against current manifest constraints.
 * Returns sanitized override, or null if the hook is no longer in the registry.
 */
export function reconcileOverride(override: HookOverride, manifestLookup: ManifestLookupFn): HookOverride | null {
  const manifest = manifestLookup(override.hookId);
  if (!manifest) return null;

  let sanitized = override;

  if (sanitized.enabled === false && !manifest.disableable) {
    const { enabled: _, ...rest } = sanitized;
    sanitized = rest as HookOverride;
  }

  if (sanitized.contentOverride !== undefined && manifest.safetyTier === 'readonly') {
    const { contentOverride: _, contentVersion: __, contentSource: _cs, ...rest } = sanitized;
    sanitized = rest as HookOverride;
  }

  if (
    sanitized.contentOverride !== undefined &&
    manifest.safetyTier === 'limited-edit' &&
    sanitized.contentSource !== 'operator'
  ) {
    const { contentOverride: _, contentVersion: __, contentSource: _cs, ...rest } = sanitized;
    sanitized = rest as HookOverride;
  }

  return sanitized;
}
