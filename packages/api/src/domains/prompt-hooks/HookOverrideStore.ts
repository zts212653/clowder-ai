/**
 * HookOverrideStore — Redis-backed per-workspace override layer for prompt hooks.
 * Enforces safetyTier/disableable gating via internal manifest lookup (codex P1, PR #22).
 *
 * Storage: HASH hook-override:{ws}, ZSET events, KEY event detail (TTL=0).
 * Event recording + reconciliation extracted to hook-override-event-recorder.ts.
 */

import type {
  HookCondition,
  HookManifest,
  HookOverride,
  HookOverrideSource,
  OverrideChangeEvent,
} from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { type EpochOrigin, HookOverrideContentStore } from './HookOverrideContentStore.js';
import { isHookCondition } from './hook-condition-policy.js';
import { HookOverrideEventRecorder, reconcileOverride } from './hook-override-event-recorder.js';

/** Resolves a HookManifest by hookId. Returns undefined for unknown hooks. */
export type ManifestLookup = (hookId: string) => HookManifest | undefined;

const OVERRIDE_HASH = (ws: string) => `hook-override:${ws}`;

/** Thrown when an override operation violates manifest safety constraints. */
export class OverrideGateError extends Error {
  constructor(
    public readonly hookId: string,
    public readonly action: string,
    public readonly gate: 'disableable' | 'safetyTier' | 'governanceTier' | 'condition' | 'unknown-hook',
    public readonly manifestValue: string | boolean,
  ) {
    super(`Override rejected: hook '${hookId}' ${action} blocked by ${gate}=${String(manifestValue)}`);
    this.name = 'OverrideGateError';
  }
}

export class HookOverrideStore {
  private readonly events: HookOverrideEventRecorder;
  private readonly content: HookOverrideContentStore;

  constructor(
    private readonly redis: RedisClient,
    private readonly manifestLookup: ManifestLookup,
    private readonly defaultWorkspaceId = 'default',
  ) {
    this.events = new HookOverrideEventRecorder(redis);
    this.content = new HookOverrideContentStore({
      redis,
      events: this.events,
      defaultWorkspaceId,
      resolveManifest: (hookId) => this.resolveManifest(hookId),
      assertContentEditable: (hookId, source) => this.assertContentEditable(hookId, source),
      getOverride: (hookId, workspaceId) => this.getOverride(hookId, workspaceId),
      writeOverride: async (workspaceId, hookId, override) => {
        await this.redis.hset(OVERRIDE_HASH(workspaceId), hookId, JSON.stringify(override));
      },
    });
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

  private assertConditionEditable(hookId: string, source: HookOverrideSource): void {
    const manifest = this.resolveManifest(hookId);
    if (manifest.governanceTier === 'immutable') {
      throw new OverrideGateError(hookId, 'condition-set', 'governanceTier', 'immutable');
    }
    if (manifest.governanceTier === 'human-gated' && source !== 'operator') {
      throw new OverrideGateError(hookId, 'condition-set', 'governanceTier', 'human-gated');
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
    opts?: { source?: HookOverrideSource; workspaceId?: string; reason?: string; parentVersion?: number },
  ): Promise<void> {
    return this.content.set(hookId, content, actorId, opts);
  }

  async clearContentOverride(
    hookId: string,
    actorId: string,
    opts?: { source?: HookOverrideSource; workspaceId?: string; reason?: string },
  ): Promise<void> {
    return this.content.clear(hookId, actorId, opts);
  }

  async setConditionOverride(
    hookId: string,
    condition: HookCondition,
    actorId: string,
    opts?: { source?: HookOverrideSource; workspaceId?: string; reason?: string },
  ): Promise<void> {
    const source = opts?.source ?? 'operator';
    this.assertConditionEditable(hookId, source);
    if (!isHookCondition(condition)) throw new OverrideGateError(hookId, 'condition-set', 'condition', 'invalid');
    const ws = opts?.workspaceId ?? this.defaultWorkspaceId;
    const existing = await this.getOverride(hookId, ws);
    const override: HookOverride = {
      ...(existing ?? {}),
      hookId,
      conditionOverride: structuredClone(condition),
      conditionSource: source,
      source,
      updatedAt: Date.now(),
      updatedBy: actorId,
    };
    await this.redis.hset(OVERRIDE_HASH(ws), hookId, JSON.stringify(override));
    await this.events.record(ws, hookId, 'condition-set', source, actorId, opts?.reason);
  }

  async clearConditionOverride(
    hookId: string,
    actorId: string,
    opts?: { source?: HookOverrideSource; workspaceId?: string; reason?: string },
  ): Promise<void> {
    const source = opts?.source ?? 'operator';
    this.assertConditionEditable(hookId, source);
    const ws = opts?.workspaceId ?? this.defaultWorkspaceId;
    const existing = await this.getOverride(hookId, ws);
    if (!existing?.conditionOverride) return;
    const { conditionOverride: _, conditionSource: __, ...rest } = existing;
    const override: HookOverride = { ...rest, hookId, source, updatedAt: Date.now(), updatedBy: actorId };
    await this.redis.hset(OVERRIDE_HASH(ws), hookId, JSON.stringify(override));
    await this.events.record(ws, hookId, 'condition-clear', source, actorId, opts?.reason);
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
    opts?: { source?: HookOverrideSource; workspaceId?: string; reason?: string; origin?: EpochOrigin },
  ): Promise<void> {
    return this.content.activate(hookId, epochVersion, actorId, opts);
  }

  /** List all stored version snapshots for a hook. */
  async listVersions(
    hookId: string,
    workspaceId?: string,
  ): Promise<Array<{ version: number; contentPreview: string }>> {
    return this.content.listVersions(hookId, workspaceId);
  }

  /** Read the immutable full-content snapshot for one epoch version. */
  async getVersionContent(hookId: string, epochVersion: number, workspaceId?: string): Promise<string | null> {
    return this.content.getVersionContent(hookId, epochVersion, workspaceId);
  }

  /** True for the immutable manifest baseline or a stored epoch snapshot. */
  async hasVersion(hookId: string, epochVersion: number, workspaceId?: string): Promise<boolean> {
    return this.content.hasVersion(hookId, epochVersion, workspaceId);
  }

  // -- Read operations ------------------------------------------------------

  /** Current effective epoch version; the immutable manifest is the base. */
  async getActiveVersion(hookId: string, workspaceId?: string): Promise<number> {
    return this.content.getActiveVersion(hookId, workspaceId);
  }

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
}
