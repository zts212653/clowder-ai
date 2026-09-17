import { join } from 'node:path';
import {
  codexAppServerHostColdSpawn,
  codexAppServerHostEviction,
  codexAppServerHostLive,
  codexAppServerHostWarmReuse,
  codexAppServerLeaseActive,
} from '../../../../../infrastructure/telemetry/instruments.js';
import type { AgentCarrierSession, AgentCarrierSessionOptions } from '../../types.js';
import { createCodexAppServerHostAttachment } from './CodexAppServerHostAttachment.js';
import { wrapReservedHostConnection } from './CodexAppServerHostConnections.js';
import {
  CodexAppServerHostLease,
  type HostCloseReason,
  type HostEntry,
  notifyHostLeaseReleased,
  resolveHostEntry,
} from './CodexAppServerHostLease.js';
import { retireCodexSessionHost } from './CodexAppServerHostRetirement.js';
import { withCodexSessionHostAcquisition } from './CodexSessionHostAcquisition.js';
import {
  type CodexAppServerHostLaunch,
  type PreparedCodexHostLaunch,
  prepareCodexHostLaunch,
  withUnixListener,
} from './CodexUnixWebSocketSession.js';
import {
  type CodexAppServerHostPoolMetrics,
  emptyCodexAppServerHostPoolMetrics,
} from './codex-app-server-host-metrics.js';
import {
  type CodexAppServerHostPoolConfig,
  type CodexAppServerHostPoolDeps,
  DEFAULT_CODEX_APP_SERVER_HOST_POOL_DEPS,
} from './codex-app-server-host-pool-deps.js';

export type { CodexAppServerHostPoolConfig, CodexAppServerHostPoolDeps } from './codex-app-server-host-pool-deps.js';
export class CodexAppServerHostPool {
  private readonly entries = new Set<HostEntry>();
  private readonly sessionOwners = new Map<string, HostEntry>();
  private readonly pendingSpawns = new Set<Promise<HostEntry>>();
  private readonly pendingConnections = new Set<Promise<AgentCarrierSession>>();
  private readonly pendingCloses = new Set<Promise<void>>();
  private readonly pendingSessionAcquisitions = new Map<string, Promise<void>>();
  private closed = false;
  private closeAllPromise: Promise<void> | null = null;
  private readonly metrics: CodexAppServerHostPoolMetrics = emptyCodexAppServerHostPoolMetrics();
  constructor(
    private readonly config: CodexAppServerHostPoolConfig,
    private readonly deps: CodexAppServerHostPoolDeps = DEFAULT_CODEX_APP_SERVER_HOST_POOL_DEPS,
  ) {}
  async createSession(options: AgentCarrierSessionOptions): Promise<AgentCarrierSession> {
    return withCodexSessionHostAcquisition(this.pendingSessionAcquisitions, options.sessionId, () =>
      this.createReservedSession(options),
    );
  }
  async createSessionAttachment(options: AgentCarrierSessionOptions): Promise<AgentCarrierSession> {
    const sessionId = options.sessionId?.trim();
    if (!sessionId) throw new Error('Codex host attachment requires an existing session id');
    return withCodexSessionHostAcquisition(this.pendingSessionAcquisitions, sessionId, () =>
      this.createAttachedSession({ ...options, sessionId }),
    );
  }
  private async createReservedSession(options: AgentCarrierSessionOptions): Promise<AgentCarrierSession> {
    this.ensureOpen();
    const prepared = prepareCodexHostLaunch(options);
    await this.reapDeadEntries();
    this.ensureOpen();
    let resolved = resolveHostEntry(this.entries, this.sessionOwners, prepared.signature, options.sessionId);
    if (resolved.retirement && options.sessionId) {
      await retireCodexSessionHost({
        ...resolved.retirement,
        sessionId: options.sessionId,
        ...(options.signal ? { signal: options.signal } : {}),
        close: (entry) => this.closeEntry(entry, 'session_migration'),
      });
      this.ensureOpen();
      resolved = resolveHostEntry(this.entries, this.sessionOwners, prepared.signature, options.sessionId);
    }
    let entry = resolved.entry;
    let reusedSessionHost = resolved.reusedSessionHost;
    let reused = !!entry;
    if (!entry) entry = await this.spawnEntry(prepared);
    this.ensureOpen();
    if (!entry.host.isAlive) {
      await this.closeEntry(entry, 'dead');
      this.ensureOpen();
      entry = await this.spawnEntry(prepared);
      this.ensureOpen();
      reused = false;
      reusedSessionHost = false;
    }
    let lease: CodexAppServerHostLease;
    lease = new CodexAppServerHostLease({
      invocationId: options.invocationId,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(this.config.abortGraceMs !== undefined ? { abortGraceMs: this.config.abortGraceMs } : {}),
      onAbandoned: async () => {
        if (entry.lease === lease) await this.closeEntry(entry, 'forced');
      },
    });
    const wasWarm = entry.warm;
    entry.lease = lease;
    if (lease.sessionId) this.sessionOwners.set(lease.sessionId, entry);
    entry.warm = false;
    entry.lastUsedAt = Date.now();
    this.clearIdleTimer(entry);
    this.metrics.activeLeaseCount++;
    codexAppServerLeaseActive.add(1);
    if (reused && wasWarm) {
      this.metrics.warmHostCount--;
      this.metrics.warmHitCount++;
      codexAppServerHostWarmReuse.add(1);
    }

    try {
      const connection = await this.connectEntry(entry);
      return wrapReservedHostConnection({
        connection,
        reusedSessionHost,
        abortObserved: () => lease.abortObserved,
        releaseLease: () => this.releaseActiveLease(entry, lease),
        releaseHost: () => this.releaseEntry(entry),
        terminateHost: () => this.closeEntry(entry, 'forced'),
        rememberSession: (sessionId) => this.rememberSession(entry, lease, sessionId),
      });
    } catch (error) {
      await this.closeEntry(entry, 'connect_failed');
      throw error;
    }
  }
  private async createAttachedSession(options: AgentCarrierSessionOptions & { sessionId: string }) {
    return createCodexAppServerHostAttachment(options, {
      entries: this.entries,
      sessionOwners: this.sessionOwners,
      ensureOpen: () => this.ensureOpen(),
      reapDeadEntries: () => this.reapDeadEntries(),
      spawnEntry: (prepared) => this.spawnEntry(prepared),
      connectEntry: (entry) => this.connectEntry(entry),
      closeEntry: (entry, reason) => this.closeEntry(entry, reason),
      releaseEntry: (entry) => this.releaseEntry(entry),
      clearIdleTimer: (entry) => this.clearIdleTimer(entry),
      recordWarmReuse: () => this.recordWarmReuse(),
    });
  }
  getMetrics(): Readonly<CodexAppServerHostPoolMetrics> {
    return { ...this.metrics };
  }
  closeAll(): Promise<void> {
    if (this.closeAllPromise) return this.closeAllPromise;
    this.closed = true;
    this.closeAllPromise = this.finishCloseAll();
    return this.closeAllPromise;
  }
  private async finishCloseAll(): Promise<void> {
    await Promise.allSettled([...this.pendingSpawns]);
    const closePromises = new Set<Promise<void>>([
      ...this.pendingCloses,
      ...[...this.entries].map((entry) => this.closeEntry(entry, 'shutdown')),
    ]);
    const results = await Promise.allSettled([...closePromises]);
    await Promise.allSettled([...this.pendingConnections]);
    this.sessionOwners.clear();
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (failures.length > 0) throw new AggregateError(failures, 'Failed to close Codex app-server host pool');
  }

  private async reapDeadEntries(): Promise<void> {
    const dead = [...this.entries].filter((entry) => !entry.host.isAlive);
    await Promise.all(dead.map((entry) => this.closeEntry(entry, 'dead')));
  }

  private async spawnEntry(prepared: PreparedCodexHostLaunch): Promise<HostEntry> {
    const pending = this.launchEntry(prepared);
    this.pendingSpawns.add(pending);
    try {
      return await pending;
    } finally {
      this.pendingSpawns.delete(pending);
    }
  }

  private async launchEntry(prepared: PreparedCodexHostLaunch): Promise<HostEntry> {
    const socketDirectory = this.deps.createSocketDirectory();
    const socketPath = join(socketDirectory, 'app.sock');
    const launch: CodexAppServerHostLaunch = {
      ...prepared.launch,
      args: withUnixListener(prepared.launch.args, socketPath),
      socketDirectory,
      socketPath,
    };
    try {
      const host = await this.deps.spawnHost(launch);
      const entry: HostEntry = {
        signature: prepared.signature,
        host,
        socketDirectory,
        state: 'ready',
        lease: null,
        attachmentCount: 0,
        warm: false,
        lastUsedAt: Date.now(),
        idleTimer: null,
        closePromise: null,
        leaseReleaseWaiters: new Set(),
      };
      this.entries.add(entry);
      this.metrics.liveHostCount++;
      this.metrics.coldStartCount++;
      codexAppServerHostLive.add(1);
      codexAppServerHostColdSpawn.add(1);
      return entry;
    } catch (error) {
      await this.deps.removeSocketDirectory(socketDirectory).catch(() => {});
      throw error;
    }
  }

  private async connectEntry(entry: HostEntry): Promise<AgentCarrierSession> {
    const pending = (async () => {
      const connection = await this.deps.connectHost(entry.host);
      if (this.closed || entry.state !== 'ready' || !this.entries.has(entry) || !entry.host.isAlive) {
        await connection.close().catch(() => {});
        throw new Error(
          this.closed ? 'Codex app-server host pool is closed' : 'Codex app-server host became unavailable',
        );
      }
      return connection;
    })();
    this.pendingConnections.add(pending);
    try {
      return await pending;
    } finally {
      this.pendingConnections.delete(pending);
    }
  }

  private rememberSession(entry: HostEntry, lease: CodexAppServerHostLease, sessionId: string): void {
    if (entry.state !== 'ready' || entry.lease !== lease || !lease.bindSession(sessionId)) return;
    this.sessionOwners.set(lease.sessionId as string, entry);
  }

  private async releaseEntry(entry: HostEntry): Promise<void> {
    if (entry.state !== 'ready' || !this.entries.has(entry)) return;
    if (!entry.host.isAlive) {
      await this.closeEntry(entry, 'dead');
      return;
    }
    if (entry.warm || entry.attachmentCount > 0) return;
    if (this.config.idleTtlMs <= 0) return this.closeEntry(entry, 'idle_ttl');
    entry.lastUsedAt = Date.now();
    entry.warm = true;
    this.metrics.warmHostCount++;
    this.startIdleTimer(entry);
    const idleEntries = [...this.entries]
      .filter((candidate) => candidate.state === 'ready' && !candidate.lease && candidate.attachmentCount === 0)
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
    while (idleEntries.length > this.config.maxWarmHosts) {
      const oldest = idleEntries.shift();
      if (oldest) await this.closeEntry(oldest, 'warm_cap');
    }
  }

  private startIdleTimer(entry: HostEntry): void {
    this.clearIdleTimer(entry);
    entry.idleTimer = setTimeout(
      () => {
        if (!entry.lease && entry.attachmentCount === 0 && entry.state === 'ready') {
          void this.closeEntry(entry, 'idle_ttl');
        }
      },
      Math.max(0, this.config.idleTtlMs),
    );
    entry.idleTimer.unref?.();
  }

  private clearIdleTimer(entry: HostEntry): void {
    if (!entry.idleTimer) return;
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }

  private recordWarmReuse(): void {
    if (this.metrics.warmHostCount > 0) this.metrics.warmHostCount--;
    this.metrics.warmHitCount++;
    codexAppServerHostWarmReuse.add(1);
  }

  private closeEntry(entry: HostEntry, reason: HostCloseReason): Promise<void> {
    if (entry.closePromise) return entry.closePromise;
    entry.state = 'closing';
    const pending = this.finishCloseEntry(entry, reason);
    entry.closePromise = pending;
    this.pendingCloses.add(pending);
    void pending.then(
      () => this.pendingCloses.delete(pending),
      () => {
        this.pendingCloses.delete(pending);
        entry.closePromise = null;
      },
    );
    return pending;
  }

  private async finishCloseEntry(entry: HostEntry, reason: HostCloseReason): Promise<void> {
    this.clearIdleTimer(entry);
    this.releaseActiveLease(entry);
    entry.attachmentCount = 0;
    let closeError: unknown;
    try {
      await entry.host.close();
    } catch (error) {
      closeError = error;
    }
    if (entry.host.isAlive) throw closeError ?? new Error('Codex app-server source host remained alive after close');
    this.entries.delete(entry);
    if (entry.warm && this.metrics.warmHostCount > 0) this.metrics.warmHostCount--;
    entry.warm = false;
    if (this.metrics.liveHostCount > 0) this.metrics.liveHostCount--;
    codexAppServerHostLive.add(-1);
    if (reason === 'forced' || reason === 'idle_ttl' || reason === 'session_migration' || reason === 'warm_cap') {
      this.metrics.evictionCount++;
      codexAppServerHostEviction.add(1, { status: reason });
    }
    await this.deps.removeSocketDirectory(entry.socketDirectory).catch(() => {});
    for (const [sessionId, owner] of this.sessionOwners) {
      if (owner === entry) this.sessionOwners.delete(sessionId);
    }
  }

  private releaseActiveLease(entry: HostEntry, expected?: CodexAppServerHostLease): boolean {
    const lease = entry.lease;
    if (!lease || (expected && lease !== expected)) return false;
    entry.lease = null;
    lease.dispose();
    notifyHostLeaseReleased(entry);
    if (this.metrics.activeLeaseCount > 0) {
      this.metrics.activeLeaseCount--;
      codexAppServerLeaseActive.add(-1);
    }
    return true;
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error('Codex app-server host pool is closed');
  }
}
