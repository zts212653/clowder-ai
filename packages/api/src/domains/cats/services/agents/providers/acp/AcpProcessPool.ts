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

export const DEFAULT_ACP_IDLE_TTL_MS = 30 * 60 * 1000;

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
  /** False when the requested persisted session was sealed and must be replaced with session/new. */
  readonly canResumeRequestedSession?: boolean;
  release(): void;
}

export interface AcpAcquireOptions {
  /** Existing ACP session id that should resume on the client that owns it. */
  sessionId?: string;
}

/** Minimal AcpClient interface needed by the pool. */
export interface AcpPoolClient {
  readonly isAlive: boolean;
  /**
   * #1203: False when the process's bootstrap cwd was deleted after spawn (e.g.
   * by an external cleaner). The child stays alive but any prompt dies with
   * getcwd ENOENT, so the pool must retire it and cold-start a fresh process
   * (cold start re-creates the cwd before spawn). Required: transports without
   * a local cwd must explicitly return true; undefined is no longer allowed to
   * silently escape retirement.
   */
  readonly isCwdIntact: boolean;
  /**
   * False after a cancelled prompt may still be running upstream. The pool only
   * acts on this for non-multiplexed carriers; multiplexed clients can keep
   * serving unrelated sessions.
   */
  readonly isSafeForSingleFlightReuse?: boolean;
  /** Session-scoped counterpart used to seal only the cancelled logical session on multiplexed carriers. */
  isSessionSafeForReuse?(sessionId: string): boolean;
  initialize(): Promise<unknown>;
  close(): Promise<void>;
}

/** Factory that creates fresh AcpClient instances. */
// biome-ignore lint: AcpClient extends this but has more methods — pool doesn't care
export type AcpClientFactory = () => AcpPoolClient; // eslint-disable-line @typescript-eslint/no-explicit-any

// ── Internal ──────────────────────────────────────────────────

interface AcpPoolVariantConfig {
  supportsMultiplexing?: boolean;
}

interface PoolEntry {
  client: AcpPoolClient;
  poolKey: PoolKey;
  leaseCount: number;
  /** Bumped on stale-lease force-release so old lease closures become no-ops (#992). */
  leaseGeneration: number;
  lastUsedAt: number;
  state: 'initializing' | 'ready' | 'closing';
  idleTimer: ReturnType<typeof setTimeout> | null;
}

function serializeKey(key: PoolKey): string {
  return `${key.projectPath}::${key.providerProfile}`;
}

function serializeSessionKey(key: PoolKey, sessionId: string): string {
  return `${serializeKey(key)}::${sessionId}`;
}

function resolveSupportsMultiplexing(variantConfig: unknown): boolean {
  if (!variantConfig || typeof variantConfig !== 'object') return false;
  return (variantConfig as AcpPoolVariantConfig).supportsMultiplexing === true;
}

// ── Pool ──────────────────────────────────────────────────────

export class AcpProcessPool {
  readonly spawnSignature?: string;
  private readonly config: AcpPoolConfig;
  private readonly supportsMultiplexing: boolean;
  private readonly entries = new Map<string, PoolEntry[]>();
  private readonly sessionOwners = new Map<string, PoolEntry>();
  /** Persisted session ids that must never be loaded again after unacknowledged local termination. */
  private readonly sealedSessions = new Set<string>();
  private readonly clientFactory: AcpClientFactory;
  private readonly pendingSpawns = new Map<string, Promise<PoolEntry>>();
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private retiring = false;
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
    variantConfig: unknown,
    clientFactory: AcpClientFactory,
    spawnSignature?: string,
  ) {
    this.spawnSignature = spawnSignature;
    this.config = {
      maxLiveProcesses: config.maxLiveProcesses,
      idleTtlMs: config.idleTtlMs ?? DEFAULT_ACP_IDLE_TTL_MS,
      evictionPolicy: config.evictionPolicy ?? 'lru',
      healthCheckIntervalMs: config.healthCheckIntervalMs ?? 30_000,
    };
    this.supportsMultiplexing = resolveSupportsMultiplexing(variantConfig);
    this.clientFactory = clientFactory;
    this.startHealthCheck();
  }

  // ── Public API ──────────────────────────────────────────────

  async acquire(poolKey: PoolKey, options: AcpAcquireOptions = {}): Promise<AcpLease> {
    if (this.closed) throw new Error('Pool is closed');
    if (this.retiring) throw new Error('Pool is retired');

    const key = serializeKey(poolKey);
    const entries = this.entries.get(key) ?? [];
    const sessionId = options.sessionId?.trim();
    let canResumeRequestedSession = true;

    // #1203: Retire ready processes whose bootstrap cwd was deleted after spawn.
    // The child is still alive, but getcwd() inside it fails — the next prompt
    // would surface ACP -32603 ENOENT. Retiring here covers both the warm-reuse
    // path and the session-owner path (retireEntry forgets owned sessions), so
    // the caller cold-starts a fresh process that re-creates the cwd at spawn.
    for (const entry of [...entries]) {
      if (entry.state === 'ready' && entry.client.isAlive && entry.client.isCwdIntact === false) {
        this.retireEntry(entry, poolKey, 'bootstrap cwd missing');
      }
    }

    if (sessionId) {
      const sessionKey = serializeSessionKey(poolKey, sessionId);
      if (this.sealedSessions.has(sessionKey)) {
        canResumeRequestedSession = false;
        this.sessionOwners.delete(sessionKey);
        log.warn({ poolKey, sessionId }, 'ACP session is sealed; acquiring carrier for a fresh replacement session');
      } else {
        const owner = this.sessionOwners.get(sessionKey);
        if (owner && owner.state === 'ready' && owner.client.isAlive) {
          if (!this.supportsMultiplexing && owner.client.isSafeForSingleFlightReuse === false) {
            this.sealSession(poolKey, sessionId);
            canResumeRequestedSession = false;
            this.retireEntry(owner, poolKey, 'cancelled prompt still unquiesced');
          } else {
            if (this.supportsMultiplexing || owner.leaseCount === 0) {
              return this.leaseReadyEntry(owner, poolKey, canResumeRequestedSession);
            }
            // #992: Stale lease recovery — the previous lease holder is a zombie (e.g. Windows
            // console disconnect where the async generator finally block never ran). Since the
            // caller is re-acquiring the SAME sessionId, the previous consumer is necessarily
            // gone. Force-release the orphaned lease so the process can be reused.
            log.warn(
              { poolKey, sessionId, staleLeaseCount: owner.leaseCount },
              'ACP stale lease detected — force-releasing zombie lease for session re-acquire',
            );
            this._metrics.activeLeaseCount -= owner.leaseCount;
            owner.leaseCount = 0;
            // Transition to idle so leaseReadyEntry's idleProcessCount-- is balanced.
            this._metrics.idleProcessCount++;
            // Bump generation so any late-arriving release() from the old lease becomes a
            // no-op (the old closure captured the previous generation value).
            owner.leaseGeneration++;
            return this.leaseReadyEntry(owner, poolKey, canResumeRequestedSession);
          }
        }
        if (owner) this.sessionOwners.delete(sessionKey);
      }
    }

    // 1. Try warm reuse. Single-flight carriers may reuse only idle processes.
    const warm = entries.find(
      (e) => e.state === 'ready' && e.client.isAlive && (this.supportsMultiplexing || e.leaseCount === 0),
    );
    if (warm) {
      return this.leaseReadyEntry(warm, poolKey, canResumeRequestedSession);
    }

    // 2. Coalesce in-flight spawns only for carriers that permit concurrent prompts.
    if (this.supportsMultiplexing) {
      const pending = this.pendingSpawns.get(key);
      if (pending) {
        const entry = await pending;
        entry.leaseCount++;
        entry.lastUsedAt = Date.now();
        this._metrics.activeLeaseCount++;
        this._metrics.warmHitCount++;
        return this.createLease(entry, poolKey, canResumeRequestedSession);
      }
    }

    // 3. Cold start — check capacity, reject if full and nothing to evict
    if (this._metrics.liveProcessCount >= this.config.maxLiveProcesses) {
      if (!this.evictOne()) {
        throw new Error('Pool at capacity — all processes have active leases');
      }
    }

    // 4. Reserve slot atomically (sync) before async spawn
    this._metrics.liveProcessCount++;

    const spawnPromise = this.doSpawn(poolKey, key, this.supportsMultiplexing ? key : undefined);
    if (this.supportsMultiplexing) this.pendingSpawns.set(key, spawnPromise);

    const entry = await spawnPromise;
    return this.createLease(entry, poolKey, canResumeRequestedSession);
  }

  /** Seal a logical session after local termination without provider quiescence. */
  sealSession(poolKey: PoolKey, sessionId: string): void {
    const trimmedSessionId = sessionId.trim();
    if (!trimmedSessionId) return;
    const sessionKey = serializeSessionKey(poolKey, trimmedSessionId);
    this.sealedSessions.add(sessionKey);
    this.sessionOwners.delete(sessionKey);
  }

  rememberSession(poolKey: PoolKey, sessionId: string, lease: AcpLease): void {
    const trimmedSessionId = sessionId.trim();
    if (!trimmedSessionId) return;

    const sessionKey = serializeSessionKey(poolKey, trimmedSessionId);
    if (this.sealedSessions.has(sessionKey)) {
      log.warn({ poolKey, sessionId: trimmedSessionId }, 'ACP session affinity skipped for sealed session');
      return;
    }

    const key = serializeKey(poolKey);
    const entry = this.entries.get(key)?.find((candidate) => candidate.client === lease.client);
    if (!entry || entry.state === 'closing' || !entry.client.isAlive) {
      log.warn({ poolKey, sessionId: trimmedSessionId }, 'ACP session affinity skipped for missing pool entry');
      return;
    }

    this.sessionOwners.set(sessionKey, entry);
  }

  private async doSpawn(poolKey: PoolKey, key: string, pendingKey?: string): Promise<PoolEntry> {
    try {
      const entry = await this.spawnEntry(poolKey);
      // The acquire that reserved this process owns its first lease before the
      // entry becomes visible to retirement/eviction. Publishing a ready entry
      // with leaseCount=0 creates a microtask-sized window where
      // retireWhenIdle() can close it before acquire() resumes.
      entry.leaseCount = 1;
      this._metrics.activeLeaseCount++;
      if (!this.entries.has(key)) this.entries.set(key, []);
      this.entries.get(key)!.push(entry);
      this._metrics.coldStartCount++;
      return entry;
    } catch (err) {
      this._metrics.liveProcessCount--; // release reservation on failure
      throw err;
    } finally {
      if (pendingKey) this.pendingSpawns.delete(pendingKey);
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
    this.sessionOwners.clear();
    this.sealedSessions.clear();
    this._metrics.liveProcessCount = 0;
    this._metrics.activeLeaseCount = 0;
    this._metrics.idleProcessCount = 0;
  }

  /**
   * Stop admitting work to this generation without interrupting active leases.
   * Idle processes close immediately; leased processes close when their final
   * invocation releases them.
   */
  retireWhenIdle(): void {
    if (this.closed || this.retiring) return;
    this.retiring = true;
    this.stopHealthCheck();

    for (const entries of [...this.entries.values()]) {
      for (const entry of [...entries]) {
        if (entry.leaseCount > 0 || entry.state !== 'ready') continue;
        this.closeRetiredEntry(entry, entry.poolKey, true);
      }
    }
  }

  // ── Internal ────────────────────────────────────────────────

  private leaseReadyEntry(entry: PoolEntry, poolKey: PoolKey, canResumeRequestedSession = true): AcpLease {
    if (entry.leaseCount === 0) {
      this._metrics.idleProcessCount--;
    }
    this.clearIdleTimer(entry);
    entry.leaseCount++;
    entry.lastUsedAt = Date.now();
    this._metrics.activeLeaseCount++;
    this._metrics.warmHitCount++;
    return this.createLease(entry, poolKey, canResumeRequestedSession);
  }

  private createLease(entry: PoolEntry, poolKey: PoolKey, canResumeRequestedSession = true): AcpLease {
    let released = false;
    // Capture the generation at lease creation time. If a stale-lease force-release
    // bumps the generation before this closure runs, the release becomes a no-op —
    // preventing the late-arriving old finally from corrupting the new lease (#992).
    const creationGeneration = entry.leaseGeneration;
    return {
      client: entry.client,
      poolKey,
      canResumeRequestedSession,
      release: () => {
        if (released) return;
        released = true;
        // Stale lease guard: generation mismatch means this lease was force-released
        // and a new lease has been issued on the same entry. The old release is a no-op.
        if (entry.leaseGeneration !== creationGeneration) return;
        // Persist session-scoped poison before either returning a multiplexed
        // carrier to the pool or retiring a single-flight carrier.
        this.sealUnsafeSessionsForEntry(entry, poolKey);
        // A local cancel can settle the JavaScript iterator before the provider
        // actually stops the upstream prompt. Reusing that same non-multiplexed
        // process would overlap two prompts on a single-flight carrier. Retire it
        // while the lease is still counted active, then let the next acquire spawn.
        if (!this.supportsMultiplexing && entry.client.isSafeForSingleFlightReuse === false) {
          this.retireEntry(entry, poolKey, 'cancelled prompt still unquiesced');
          return;
        }
        entry.leaseCount--;
        this._metrics.activeLeaseCount--;
        if (entry.leaseCount <= 0) {
          entry.leaseCount = 0;
          if (this.retiring) {
            this.closeRetiredEntry(entry, poolKey, false);
          } else {
            this._metrics.idleProcessCount++;
            this.startIdleTimer(entry, poolKey);
          }
        }
      },
    };
  }

  private closeRetiredEntry(entry: PoolEntry, poolKey: PoolKey, idleWasCounted: boolean): void {
    const key = serializeKey(poolKey);
    const entries = this.entries.get(key);
    const index = entries?.indexOf(entry) ?? -1;
    if (!entries || index < 0 || entry.state === 'closing') return;

    this.clearIdleTimer(entry);
    this.forgetSessionsForEntry(entry);
    entry.state = 'closing';
    entries.splice(index, 1);
    if (entries.length === 0) this.entries.delete(key);
    this._metrics.liveProcessCount--;
    if (idleWasCounted) this._metrics.idleProcessCount--;
    entry.client.close().catch(() => {});
  }

  private retireEntry(entry: PoolEntry, poolKey: PoolKey, reason: string): void {
    const key = serializeKey(poolKey);
    const entries = this.entries.get(key);
    const idx = entries?.indexOf(entry) ?? -1;
    if (!entries || idx < 0 || entry.state === 'closing') return;

    this.clearIdleTimer(entry);
    this.sealUnsafeSessionsForEntry(entry, poolKey);
    this.forgetSessionsForEntry(entry);
    entry.state = 'closing';

    if (entry.leaseCount > 0) {
      this._metrics.activeLeaseCount -= entry.leaseCount;
      entry.leaseCount = 0;
      // Any late release from an already-retired lease must not touch metrics.
      entry.leaseGeneration++;
    } else {
      this._metrics.idleProcessCount--;
    }

    entries.splice(idx, 1);
    if (entries.length === 0) this.entries.delete(key);
    this._metrics.liveProcessCount--;
    this._metrics.evictionCount++;
    entry.client.close().catch(() => {});
    log.warn({ poolKey, reason }, 'Retired unsafe ACP process');
  }

  /** Persist session poison before owner affinity is removed or the carrier is retired. */
  private sealUnsafeSessionsForEntry(entry: PoolEntry, poolKey: PoolKey): void {
    const prefix = `${serializeKey(poolKey)}::`;
    for (const [sessionKey, owner] of this.sessionOwners) {
      if (owner !== entry || !sessionKey.startsWith(prefix)) continue;
      const sessionId = sessionKey.slice(prefix.length);
      if (entry.client.isSessionSafeForReuse?.(sessionId) === false) {
        this.sealedSessions.add(sessionKey);
      }
    }
  }

  private async spawnEntry(poolKey: PoolKey): Promise<PoolEntry> {
    const client = this.clientFactory();
    const entry: PoolEntry = {
      client,
      poolKey,
      leaseCount: 0, // doSpawn claims the admitted acquire before publishing
      leaseGeneration: 0,
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
    this.forgetSessionsForEntry(oldest.entry);
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
      this.forgetSessionsForEntry(entry);
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
            this.forgetSessionsForEntry(entry);
            entries.splice(i, 1);
            this._metrics.liveProcessCount--;
            if (entry.leaseCount > 0) {
              this._metrics.activeLeaseCount -= entry.leaseCount;
            } else {
              this._metrics.idleProcessCount--;
            }
            this._metrics.zombieCleanupCount++;
            log.warn({ key }, 'Zombie process cleaned up');
          } else if (entry.client.isCwdIntact === false) {
            // #1203: Alive but cwd-less — full retirement semantics, not the
            // zombie shortcut: the process must actually be closed, and an
            // active lease's generation must be invalidated so its late
            // release() becomes a no-op instead of double-decrementing metrics.
            this.retireEntry(entry, entry.poolKey, 'bootstrap cwd missing');
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

  private forgetSessionsForEntry(entry: PoolEntry): void {
    for (const [sessionKey, owner] of this.sessionOwners) {
      if (owner === entry) this.sessionOwners.delete(sessionKey);
    }
  }
}
