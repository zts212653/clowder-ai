/**
 * HookOverrideStore — Redis-backed per-workspace override layer for prompt hooks.
 * Enforces safetyTier/disableable gating via internal manifest lookup (codex P1, PR #22).
 *
 * Storage: HASH hook-override:{ws}, ZSET events, KEY event detail (TTL=0).
 * Event recording + reconciliation extracted to hook-override-event-recorder.ts.
 */

import type { HookManifest, HookOverride, HookOverrideSource, OverrideChangeEvent } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { HookOverrideEventRecorder, reconcileOverride } from './hook-override-event-recorder.js';

/** Resolves a HookManifest by hookId. Returns undefined for unknown hooks. */
export type ManifestLookup = (hookId: string) => HookManifest | undefined;

const OVERRIDE_HASH = (ws: string) => `hook-override:${ws}`;
/** P1-3: per-version content snapshot. HASH {epochVersion → content}. */
const VERSION_SNAPSHOT = (ws: string, hookId: string) => `hook-override-versions:${ws}:${hookId}`;
/** R7: atomic epoch counter for race-safe epochVersion assignment. */
const EPOCH_COUNTER = (ws: string, hookId: string) => `hook-override-epoch-seq:${ws}:${hookId}`;

/** Thrown when an override operation violates manifest safety constraints. */
export class OverrideGateError extends Error {
  constructor(
    public readonly hookId: string,
    public readonly action: string,
    public readonly gate: 'disableable' | 'safetyTier' | 'unknown-hook',
    public readonly manifestValue: string | boolean,
  ) {
    super(`Override rejected: hook '${hookId}' ${action} blocked by ${gate}=${String(manifestValue)}`);
    this.name = 'OverrideGateError';
  }
}

export class HookOverrideStore {
  private readonly events: HookOverrideEventRecorder;

  constructor(
    private readonly redis: RedisClient,
    private readonly manifestLookup: ManifestLookup,
    private readonly defaultWorkspaceId = 'default',
  ) {
    this.events = new HookOverrideEventRecorder(redis);
  }

  // -- Manifest resolution (fail-closed) ------------------------------------

  private resolveManifest(hookId: string): HookManifest {
    const manifest = this.manifestLookup(hookId);
    if (!manifest) {
      throw new OverrideGateError(hookId, 'resolve', 'unknown-hook', 'not-found');
    }
    return manifest;
  }

  private assertDisableable(hookId: string): void {
    const manifest = this.resolveManifest(hookId);
    if (!manifest.disableable) {
      throw new OverrideGateError(hookId, 'disable', 'disableable', false);
    }
  }

  private assertContentEditable(hookId: string, source: HookOverrideSource): void {
    const manifest = this.resolveManifest(hookId);
    if (manifest.safetyTier === 'readonly') {
      throw new OverrideGateError(hookId, 'content-set', 'safetyTier', 'readonly');
    }
    if (manifest.safetyTier === 'limited-edit' && source !== 'operator') {
      throw new OverrideGateError(hookId, 'content-set', 'safetyTier', 'limited-edit');
    }
  }

  // -- Write operations -----------------------------------------------------

  async enable(
    hookId: string,
    actorId: string,
    opts?: { source?: HookOverrideSource; workspaceId?: string; reason?: string },
  ): Promise<void> {
    this.resolveManifest(hookId);
    const ws = opts?.workspaceId ?? this.defaultWorkspaceId;
    const source = opts?.source ?? 'operator';
    const existing = await this.getOverride(hookId, ws);
    const override: HookOverride = {
      ...(existing ?? {}),
      hookId,
      enabled: true,
      enabledSource: source,
      source,
      updatedAt: Date.now(),
      updatedBy: actorId,
    };
    await this.redis.hset(OVERRIDE_HASH(ws), hookId, JSON.stringify(override));
    await this.events.record(ws, hookId, 'enable', source, actorId, opts?.reason);
  }

  async disable(
    hookId: string,
    actorId: string,
    opts?: { source?: HookOverrideSource; workspaceId?: string; reason?: string },
  ): Promise<void> {
    this.assertDisableable(hookId);
    const ws = opts?.workspaceId ?? this.defaultWorkspaceId;
    const source = opts?.source ?? 'operator';
    const existing = await this.getOverride(hookId, ws);
    const override: HookOverride = {
      ...(existing ?? {}),
      hookId,
      enabled: false,
      enabledSource: source,
      source,
      updatedAt: Date.now(),
      updatedBy: actorId,
    };
    await this.redis.hset(OVERRIDE_HASH(ws), hookId, JSON.stringify(override));
    await this.events.record(ws, hookId, 'disable', source, actorId, opts?.reason);
  }

  async setContentOverride(
    hookId: string,
    content: string,
    actorId: string,
    opts?: { source?: HookOverrideSource; workspaceId?: string; reason?: string },
  ): Promise<void> {
    const source = opts?.source ?? 'operator';
    this.assertContentEditable(hookId, source);
    const ws = opts?.workspaceId ?? this.defaultWorkspaceId;
    const existing = await this.getOverride(hookId, ws);

    // epochVersion: monotonic, never resets (I1, I3). max(manifest, max_snapshot_key) + 1.
    const manifest = this.resolveManifest(hookId);
    const epochVersion = await this.nextEpochVersion(ws, hookId, manifest.version);

    const override: HookOverride = {
      ...(existing ?? {}),
      hookId,
      contentOverride: content,
      contentVersion: (existing?.contentVersion ?? 0) + 1,
      activeEpochVersion: epochVersion,
      contentSource: source,
      source,
      updatedAt: Date.now(),
      updatedBy: actorId,
    };
    await this.redis.hset(OVERRIDE_HASH(ws), hookId, JSON.stringify(override));
    // Snapshot keyed by epochVersion (not contentVersion) — append-only (I4)
    await this.redis.hset(VERSION_SNAPSHOT(ws, hookId), String(epochVersion), content);
    await this.events.record(
      ws,
      hookId,
      'content-set',
      source,
      actorId,
      opts?.reason,
      override.contentVersion,
      epochVersion,
    );
  }

  async clearContentOverride(
    hookId: string,
    actorId: string,
    opts?: { source?: HookOverrideSource; workspaceId?: string; reason?: string },
  ): Promise<void> {
    this.resolveManifest(hookId);
    const ws = opts?.workspaceId ?? this.defaultWorkspaceId;
    const source = opts?.source ?? 'operator';
    const existing = await this.getOverride(hookId, ws);
    if (!existing) return;
    const { contentOverride: _, contentVersion: __, contentSource: _cs, activeEpochVersion: _aev, ...rest } = existing;
    const override: HookOverride = {
      ...rest,
      source,
      updatedAt: Date.now(),
      updatedBy: actorId,
    };
    await this.redis.hset(OVERRIDE_HASH(ws), hookId, JSON.stringify(override));
    await this.events.record(ws, hookId, 'content-clear', source, actorId, opts?.reason);
  }

  async rollback(
    hookId: string,
    actorId: string,
    opts?: { source?: HookOverrideSource; workspaceId?: string; reason?: string },
  ): Promise<void> {
    // Fail-closed: unknown hooks must not write audit events (terra P2, F257).
    this.resolveManifest(hookId);
    const ws = opts?.workspaceId ?? this.defaultWorkspaceId;
    const source = opts?.source ?? 'operator';
    await this.redis.hdel(OVERRIDE_HASH(ws), hookId);
    await this.events.record(ws, hookId, 'rollback', source, actorId, opts?.reason);
  }

  // -- P1-3: Version management -------------------------------------------

  /** Activate a version by epochVersion (stable monotonic ID, not contentVersion). */
  async activateVersion(
    hookId: string,
    epochVersion: number,
    actorId: string,
    opts?: { source?: HookOverrideSource; workspaceId?: string; reason?: string },
  ): Promise<void> {
    this.resolveManifest(hookId);
    const source = opts?.source ?? 'operator';
    this.assertContentEditable(hookId, source);
    const ws = opts?.workspaceId ?? this.defaultWorkspaceId;

    const content = await this.redis.hget(VERSION_SNAPSHOT(ws, hookId), String(epochVersion));
    if (content === null) {
      throw new Error(`No content snapshot for hook '${hookId}' epochVersion ${epochVersion}`);
    }

    // Restore content; do NOT reset contentVersion (edit counter, not identity)
    const existing = await this.getOverride(hookId, ws);
    const override: HookOverride = {
      ...(existing ?? {}),
      hookId,
      contentOverride: content,
      contentVersion: existing?.contentVersion ?? 1,
      activeEpochVersion: epochVersion,
      contentSource: source,
      source,
      updatedAt: Date.now(),
      updatedBy: actorId,
    };
    await this.redis.hset(OVERRIDE_HASH(ws), hookId, JSON.stringify(override));
    await this.events.record(ws, hookId, 'version-activate', source, actorId, opts?.reason, undefined, epochVersion);
  }

  /** List all stored version snapshots for a hook. */
  async listVersions(
    hookId: string,
    workspaceId?: string,
  ): Promise<Array<{ version: number; contentPreview: string }>> {
    const ws = workspaceId ?? this.defaultWorkspaceId;
    const all = await this.redis.hgetall(VERSION_SNAPSHOT(ws, hookId));
    if (!all) return [];
    return Object.entries(all)
      .map(([v, content]) => ({
        version: Number(v),
        contentPreview: content.length > 120 ? `${content.slice(0, 120)}…` : content,
      }))
      .sort((a, b) => a.version - b.version);
  }

  /** Read the immutable full-content snapshot for one epoch version. */
  async getVersionContent(hookId: string, epochVersion: number, workspaceId?: string): Promise<string | null> {
    const ws = workspaceId ?? this.defaultWorkspaceId;
    return this.redis.hget(VERSION_SNAPSHOT(ws, hookId), String(epochVersion));
  }

  // -- Read operations ------------------------------------------------------

  async getOverride(hookId: string, workspaceId?: string): Promise<HookOverride | null> {
    const raw = await this.redis.hget(OVERRIDE_HASH(workspaceId ?? this.defaultWorkspaceId), hookId);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as HookOverride;
    } catch {
      return null;
    }
  }

  async listOverrides(workspaceId?: string): Promise<HookOverride[]> {
    const all = await this.redis.hgetall(OVERRIDE_HASH(workspaceId ?? this.defaultWorkspaceId));
    if (!all) return [];
    const results: HookOverride[] = [];
    for (const v of Object.values(all)) {
      try {
        results.push(JSON.parse(v) as HookOverride);
      } catch {
        /* skip corrupted */
      }
    }
    return results;
  }

  /**
   * Load overrides as a sync Map for pipeline hot-path resolution.
   * Reconciles against current manifest (sol P1-1): tightened constraints
   * strip stale override fields.
   */
  async loadSnapshot(workspaceId?: string): Promise<ReadonlyMap<string, HookOverride>> {
    const overrides = await this.listOverrides(workspaceId);
    const result = new Map<string, HookOverride>();
    for (const override of overrides) {
      const reconciled = reconcileOverride(override, this.manifestLookup);
      if (reconciled) {
        result.set(reconciled.hookId, reconciled);
      }
    }
    return result;
  }

  // -- Event stream ---------------------------------------------------------

  async listEvents(opts?: {
    workspaceId?: string;
    limit?: number;
    since?: number;
    until?: number;
  }): Promise<OverrideChangeEvent[]> {
    return this.events.list(opts?.workspaceId ?? this.defaultWorkspaceId, opts);
  }

  // -- Internal helpers -----------------------------------------------------

  /**
   * Compute next monotonic epochVersion (I3, R7 atomicity fix).
   *
   * Uses SETNX + INCR for atomic counter: two concurrent setContentOverride()
   * calls will always get distinct epoch versions. SETNX initializes the counter
   * from max(manifestVersion, max_snapshot_key) on first use; INCR is atomic.
   */
  private async nextEpochVersion(ws: string, hookId: string, manifestVersion: number): Promise<number> {
    const counterKey = EPOCH_COUNTER(ws, hookId);
    // Initialize counter from snapshot state if it doesn't exist yet (SETNX = atomic)
    const all = await this.redis.hgetall(VERSION_SNAPSHOT(ws, hookId));
    const maxSnapshot = all ? Math.max(0, ...Object.keys(all).map(Number)) : 0;
    const initial = Math.max(manifestVersion, maxSnapshot);
    await this.redis.setnx(counterKey, String(initial));
    // INCR: atomic increment, returns new value — safe under concurrency
    return await this.redis.incr(counterKey);
  }
}
