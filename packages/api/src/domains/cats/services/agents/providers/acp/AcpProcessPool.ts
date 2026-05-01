/**
 * F149 Phase C — AcpProcessPool
 *
 * Manages a pool of AcpClient instances keyed by (projectPath, providerProfile).
 * Supports multiplexing: multiple leases can share one process.
 *
 * Lifecycle: acquire → use → release. Idle processes auto-evict after TTL.
 * Health check detects dead processes. LRU eviction when at max capacity.
 */

import { createModuleLogger } from '../../../../../../infrastructure/logger.js';

const log = createModuleLogger('acp-pool');

// ── Types ─────────────────────────────────────────────────────

export interface PoolKey {
  projectPath: string;
  providerProfile: string;
}

export interface AcpPoolConfig {
  maxLiveProcesses: number;
  idleTtlMs: number;
  evictionPolicy: 'lru';
  healthCheckIntervalMs: number;
}

export interface AcpPoolMetrics {
  liveProcessCount: number;
  activeLeaseCount: number;
  idleProcessCount: number;
  warmHitCount: number;
  coldStartCount: number;
  evictionCount: number;
  zombieCleanupCount: number;
}

export interface AcpLease {
  readonly client: AcpPoolClient;
  readonly poolKey: PoolKey;
  release(): void;
}

/** Minimal AcpClient interface needed by the pool. */
export interface AcpPoolClient {
  readonly isAlive: boolean;
  initialize(): Promise<unknown>;
  close(): Promise<void>;
}

/** Factory that creates fresh AcpClient instances. */
// biome-ignore lint: AcpClient extends this but has more methods — pool doesn't care
export type AcpClientFactory = () => AcpPoolClient; // eslint-disable-line @typescript-eslint/no-explicit-any

// ── Internal ──────────────────────────────────────────────────

interface PoolEntry {
  client: AcpPoolClient;
  leaseCount: number;
  lastUsedAt: number;
  state: 'initializing' | 'ready' | 'closing';
  idleTimer: ReturnType<typeof setTimeout> | null;
}

function serializeKey(key: PoolKey): string {
  return `${key.projectPath}::${key.providerProfile}`;
}

// ── Pool ──────────────────────────────────────────────────────

export class AcpProcessPool {
  private readonly config: AcpPoolConfig;
  private readonly entries = new Map<string, PoolEntry[]>();
  private readonly clientFactory: AcpClientFactory;
  private readonly pendingSpawns = new Map<string, Promise<PoolEntry>>();
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  private readonly _metrics: AcpPoolMetrics = {
    liveProcessCount: 0,
    activeLeaseCount: 0,
    idleProcessCount: 0,
    warmHitCount: 0,
    coldStartCount: 0,
    evictionCount: 0,
    zombieCleanupCount: 0,
  };

  constructor(
    config: Partial<AcpPoolConfig> & Pick<AcpPoolConfig, 'maxLiveProcesses'>,
    _variantConfig: unknown,
    clientFactory: AcpClientFactory,
  ) {
    this.config = {
      maxLiveProcesses: config.maxLiveProcesses,
      idleTtlMs: config.idleTtlMs ?? 5 * 60 * 1000,
      evictionPolicy: config.evictionPolicy ?? 'lru',
      healthCheckIntervalMs: config.healthCheckIntervalMs ?? 30_000,
    };
    this.clientFactory = clientFactory;
    this.startHealthCheck();
  }

  // ── Public API ──────────────────────────────────────────────

  async acquire(poolKey: PoolKey): Promise<AcpLease> {
    if (this.closed) throw new Error('Pool is closed');

    const key = serializeKey(poolKey);
    const entries = this.entries.get(key) ?? [];

    // 1. Try warm reuse (multiplexing: any ready entry)
    const warm = entries.find((e) => e.state === 'ready' && e.client.isAlive);
    if (warm) {
      if (warm.leaseCount === 0) {
        this._metrics.idleProcessCount--;
      }
      this.clearIdleTimer(warm);
      warm.leaseCount++;
      warm.lastUsedAt = Date.now();
      this._metrics.activeLeaseCount++;
      this._metrics.warmHitCount++;
      return this.createLease(warm, poolKey);
    }

    // 2. Coalesce with in-flight spawn for same key (prevents concurrent duplicate cold starts)
    const pending = this.pendingSpawns.get(key);
    if (pending) {
      const entry = await pending;
      entry.leaseCount++;
      entry.lastUsedAt = Date.now();
      this._metrics.activeLeaseCount++;
      this._metrics.warmHitCount++;
      return this.createLease(entry, poolKey);
    }

    // 3. Cold start — check capacity, reject if full and nothing to evict
    if (this._metrics.liveProcessCount >= this.config.maxLiveProcesses) {
      if (!this.evictOne()) {
        throw new Error('Pool at capacity — all processes have active leases');
      }
    }

    // 4. Reserve slot atomically (sync) before async spawn
    this._metrics.liveProcessCount++;

    const spawnPromise = this.doSpawn(poolKey, key);
    this.pendingSpawns.set(key, spawnPromise);

    const entry = await spawnPromise;
    entry.leaseCount++;
    this._metrics.activeLeaseCount++;
    return this.createLease(entry, poolKey);
  }

  private async doSpawn(poolKey: PoolKey, key: string): Promise<PoolEntry> {
    try {
      const entry = await this.spawnEntry(poolKey);
      if (!this.entries.has(key)) this.entries.set(key, []);
      this.entries.get(key)!.push(entry);
      this._metrics.coldStartCount++;
      return entry;
    } catch (err) {
      this._metrics.liveProcessCount--; // release reservation on failure
      throw err;
    } finally {
      this.pendingSpawns.delete(key);
    }
  }

  getMetrics(): Readonly<AcpPoolMetrics> {
    return { ...this._metrics };
  }

  getActivePids(): number[] {
    const pids: number[] = [];
    for (const entries of this.entries.values()) {
      for (const e of entries) {
        const pid = (e.client as { pid?: number }).pid;
        if (pid) pids.push(pid);
      }
    }
    return pids;
  }

  async closeAll(): Promise<void> {
    this.closed = true;
    this.stopHealthCheck();

    for (const [key, entries] of this.entries) {
      for (const entry of entries) {
        this.clearIdleTimer(entry);
        entry.state = 'closing';
        await entry.client.close().catch(() => {});
      }
      entries.length = 0;
    }
    this.entries.clear();
    this._metrics.liveProcessCount = 0;
    this._metrics.activeLeaseCount = 0;
    this._metrics.idleProcessCount = 0;
  }

  // ── Internal ────────────────────────────────────────────────

  private createLease(entry: PoolEntry, poolKey: PoolKey): AcpLease {
    let released = false;
    return {
      client: entry.client,
      poolKey,
      release: () => {
        if (released) return;
        released = true;
        entry.leaseCount--;
        this._metrics.activeLeaseCount--;
        if (entry.leaseCount <= 0) {
          entry.leaseCount = 0;
          this._metrics.idleProcessCount++;
          this.startIdleTimer(entry, poolKey);
        }
      },
    };
  }

  private async spawnEntry(poolKey: PoolKey): Promise<PoolEntry> {
    const client = this.clientFactory();
    const entry: PoolEntry = {
      client,
      leaseCount: 0, // caller manages lease count after spawn
      lastUsedAt: Date.now(),
      state: 'initializing',
      idleTimer: null,
    };
    try {
      await client.initialize();
    } catch (err) {
      await client.close().catch(() => {});
      throw err;
    }
    entry.state = 'ready';
    log.info({ poolKey }, 'ACP process spawned (cold start)');
    return entry;
  }

  private evictOne(): boolean {
    // Find globally oldest idle entry (LRU)
    let oldest: { key: string; entry: PoolEntry; idx: number } | null = null;
    for (const [key, entries] of this.entries) {
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (e.leaseCount > 0 || e.state !== 'ready') continue; // skip active/closing
        if (!oldest || e.lastUsedAt < oldest.entry.lastUsedAt) {
          oldest = { key, entry: e, idx: i };
        }
      }
    }

    if (!oldest) {
      log.warn('Cannot evict — all processes have active leases');
      return false;
    }

    this.clearIdleTimer(oldest.entry);
    oldest.entry.state = 'closing';
    oldest.entry.client.close().catch(() => {});
    const entries = this.entries.get(oldest.key)!;
    entries.splice(oldest.idx, 1);
    if (entries.length === 0) this.entries.delete(oldest.key);
    this._metrics.liveProcessCount--;
    this._metrics.idleProcessCount--;
    this._metrics.evictionCount++;
    log.info({ key: oldest.key }, 'Evicted LRU idle process');
    return true;
  }

  private startIdleTimer(entry: PoolEntry, poolKey: PoolKey): void {
    this.clearIdleTimer(entry);
    entry.idleTimer = setTimeout(() => {
      if (entry.leaseCount > 0 || entry.state !== 'ready') return;
      const key = serializeKey(poolKey);
      const entries = this.entries.get(key);
      if (!entries) return;
      const idx = entries.indexOf(entry);
      if (idx < 0) return;

      entry.state = 'closing';
      entry.client.close().catch(() => {});
      entries.splice(idx, 1);
      if (entries.length === 0) this.entries.delete(key);
      this._metrics.liveProcessCount--;
      this._metrics.idleProcessCount--;
      this._metrics.evictionCount++;
      log.info({ key }, 'Idle TTL eviction');
    }, this.config.idleTtlMs);
  }

  private clearIdleTimer(entry: PoolEntry): void {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
  }

  private startHealthCheck(): void {
    this.healthTimer = setInterval(() => {
      for (const [key, entries] of this.entries) {
        for (let i = entries.length - 1; i >= 0; i--) {
          const entry = entries[i];
          if (entry.state === 'closing') continue;
          if (!entry.client.isAlive) {
            this.clearIdleTimer(entry);
            entries.splice(i, 1);
            this._metrics.liveProcessCount--;
            if (entry.leaseCount > 0) {
              this._metrics.activeLeaseCount -= entry.leaseCount;
            } else {
              this._metrics.idleProcessCount--;
            }
            this._metrics.zombieCleanupCount++;
            log.warn({ key }, 'Zombie process cleaned up');
          }
        }
        if (entries.length === 0) this.entries.delete(key);
      }
    }, this.config.healthCheckIntervalMs);
  }

  private stopHealthCheck(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }
}
