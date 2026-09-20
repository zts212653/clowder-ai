import type { HookManifest, HookOverride, HookOverrideSource } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { HookOverrideEventRecorder } from './hook-override-event-recorder.js';

const VERSION_SNAPSHOT = (ws: string, hookId: string) => `hook-override-versions:${ws}:${hookId}`;
const EPOCH_COUNTER = (ws: string, hookId: string) => `hook-override-epoch-seq:${ws}:${hookId}`;

/** Which content a bare epoch number selects when both origins claim it. */
export type EpochOrigin = 'manifest' | 'local';

type Options = {
  source?: HookOverrideSource;
  workspaceId?: string;
  reason?: string;
  parentVersion?: number;
  origin?: EpochOrigin;
};

/**
 * Decide whether a bare epoch number means the shipped manifest or a local snapshot.
 *
 * Local epochs deliberately continue the manifest series so the version lifeline
 * reads v1 -> v2 -> v3, which means the two origins can collide by design: ship
 * v1, let an operator create local epoch 2, then deploy manifest v2 and the
 * number 2 now names two different contents. Before this resolver, `activate(2)`
 * took the manifest branch and silently cleared the operator's local content
 * (Codex P1, PR #1462). The numbering stays human-readable; the selector carries
 * origin instead. A caller that knows which one it means passes `opts.origin`,
 * and a genuinely ambiguous bare number fails closed rather than guessing.
 */
function resolveEpochOrigin(
  hookId: string,
  epochVersion: number,
  manifestVersion: number,
  snapshot: string | null,
  requested: EpochOrigin | undefined,
): { origin: 'manifest' } | { origin: 'local'; content: string } {
  const isManifest = epochVersion === manifestVersion;
  const local = (): { origin: 'local'; content: string } => {
    if (snapshot === null) throw new Error(`No content snapshot for hook '${hookId}' epochVersion ${epochVersion}`);
    return { origin: 'local', content: snapshot };
  };
  if (requested === 'manifest') {
    if (!isManifest) throw new Error(`Hook '${hookId}' has no shipped manifest version ${epochVersion}`);
    return { origin: 'manifest' };
  }
  if (requested === 'local') return local();
  if (isManifest && snapshot !== null) {
    throw new Error(
      `Ambiguous epochVersion ${epochVersion} for hook '${hookId}': the shipped manifest and a local snapshot both claim it; pass origin to choose`,
    );
  }
  return isManifest ? { origin: 'manifest' } : local();
}

/** Content/version sub-store extracted from HookOverrideStore's governance facade. */
export class HookOverrideContentStore {
  constructor(
    private readonly deps: {
      redis: RedisClient;
      events: HookOverrideEventRecorder;
      defaultWorkspaceId: string;
      resolveManifest: (hookId: string) => HookManifest;
      assertContentEditable: (hookId: string, source: HookOverrideSource) => void;
      getOverride: (hookId: string, workspaceId?: string) => Promise<HookOverride | null>;
      writeOverride: (workspaceId: string, hookId: string, override: HookOverride) => Promise<void>;
    },
  ) {}

  async set(hookId: string, content: string, actorId: string, opts?: Options): Promise<void> {
    const source = opts?.source ?? 'operator';
    this.deps.assertContentEditable(hookId, source);
    const ws = opts?.workspaceId ?? this.deps.defaultWorkspaceId;
    const existing = await this.deps.getOverride(hookId, ws);
    const manifest = this.deps.resolveManifest(hookId);
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
    await this.deps.writeOverride(ws, hookId, override);
    await this.deps.redis.hset(VERSION_SNAPSHOT(ws, hookId), String(epochVersion), content);
    await this.deps.events.record(
      ws,
      hookId,
      'content-set',
      source,
      actorId,
      opts?.reason,
      override.contentVersion,
      epochVersion,
      opts?.parentVersion,
    );
  }

  async clear(hookId: string, actorId: string, opts?: Options): Promise<void> {
    this.deps.resolveManifest(hookId);
    const ws = opts?.workspaceId ?? this.deps.defaultWorkspaceId;
    const source = opts?.source ?? 'operator';
    const existing = await this.deps.getOverride(hookId, ws);
    if (!existing) return;
    const { contentOverride: _, contentVersion: __, contentSource: _cs, activeEpochVersion: _aev, ...rest } = existing;
    const override: HookOverride = { ...rest, source, updatedAt: Date.now(), updatedBy: actorId };
    await this.deps.writeOverride(ws, hookId, override);
    await this.deps.events.record(ws, hookId, 'content-clear', source, actorId, opts?.reason);
  }

  async activate(hookId: string, epochVersion: number, actorId: string, opts?: Options): Promise<void> {
    const manifest = this.deps.resolveManifest(hookId);
    const source = opts?.source ?? 'operator';
    this.deps.assertContentEditable(hookId, source);
    const ws = opts?.workspaceId ?? this.deps.defaultWorkspaceId;
    const snapshot = await this.deps.redis.hget(VERSION_SNAPSHOT(ws, hookId), String(epochVersion));
    const resolved = resolveEpochOrigin(hookId, epochVersion, manifest.version, snapshot, opts?.origin);
    const existing = await this.deps.getOverride(hookId, ws);
    if (resolved.origin === 'manifest') {
      if (existing) {
        const {
          contentOverride: _,
          contentVersion: __,
          contentSource: ___,
          activeEpochVersion: ____,
          ...rest
        } = existing;
        await this.deps.writeOverride(ws, hookId, {
          ...rest,
          hookId,
          source,
          updatedAt: Date.now(),
          updatedBy: actorId,
        });
      }
      await this.deps.events.record(
        ws,
        hookId,
        'version-activate',
        source,
        actorId,
        opts?.reason,
        undefined,
        epochVersion,
      );
      return;
    }

    await this.deps.writeOverride(ws, hookId, {
      ...(existing ?? {}),
      hookId,
      contentOverride: resolved.content,
      contentVersion: existing?.contentVersion ?? 1,
      activeEpochVersion: epochVersion,
      contentSource: source,
      source,
      updatedAt: Date.now(),
      updatedBy: actorId,
    });
    await this.deps.events.record(
      ws,
      hookId,
      'version-activate',
      source,
      actorId,
      opts?.reason,
      undefined,
      epochVersion,
    );
  }

  async listVersions(
    hookId: string,
    workspaceId?: string,
  ): Promise<Array<{ version: number; contentPreview: string }>> {
    const ws = workspaceId ?? this.deps.defaultWorkspaceId;
    const all = await this.deps.redis.hgetall(VERSION_SNAPSHOT(ws, hookId));
    if (!all) return [];
    return Object.entries(all)
      .map(([version, content]) => ({
        version: Number(version),
        contentPreview: content.length > 120 ? `${content.slice(0, 120)}…` : content,
      }))
      .sort((left, right) => left.version - right.version);
  }

  async getVersionContent(hookId: string, epochVersion: number, workspaceId?: string): Promise<string | null> {
    const ws = workspaceId ?? this.deps.defaultWorkspaceId;
    return this.deps.redis.hget(VERSION_SNAPSHOT(ws, hookId), String(epochVersion));
  }

  async hasVersion(hookId: string, epochVersion: number, workspaceId?: string): Promise<boolean> {
    const manifest = this.deps.resolveManifest(hookId);
    if (epochVersion === manifest.version) return true;
    const ws = workspaceId ?? this.deps.defaultWorkspaceId;
    return (await this.deps.redis.hget(VERSION_SNAPSHOT(ws, hookId), String(epochVersion))) !== null;
  }

  async getActiveVersion(hookId: string, workspaceId?: string): Promise<number> {
    const manifest = this.deps.resolveManifest(hookId);
    const override = await this.deps.getOverride(hookId, workspaceId);
    const activeVersion = override?.activeEpochVersion;
    return override?.contentOverride !== undefined &&
      typeof activeVersion === 'number' &&
      Number.isInteger(activeVersion)
      ? activeVersion
      : manifest.version;
  }

  private async nextEpochVersion(ws: string, hookId: string, manifestVersion: number): Promise<number> {
    const counterKey = EPOCH_COUNTER(ws, hookId);
    const all = await this.deps.redis.hgetall(VERSION_SNAPSHOT(ws, hookId));
    const maxSnapshot = all ? Math.max(0, ...Object.keys(all).map(Number)) : 0;
    await this.deps.redis.setnx(counterKey, String(Math.max(manifestVersion, maxSnapshot)));
    return this.deps.redis.incr(counterKey);
  }
}
