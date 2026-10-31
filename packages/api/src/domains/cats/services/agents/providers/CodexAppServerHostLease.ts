import type { CodexAppServerHostProcess, PreparedCodexHostLaunch } from './CodexUnixWebSocketSession.js';

const DEFAULT_ABORT_GRACE_MS = 5_000;

export interface HostEntry {
  signature: string;
  authIdentity: string;
  host: CodexAppServerHostProcess;
  socketDirectory: string;
  state: 'ready' | 'closing';
  lease: CodexAppServerHostLease | null;
  attachmentCount: number;
  warm: boolean;
  lastUsedAt: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  closePromise: Promise<void> | null;
  leaseReleaseWaiters: Set<() => void>;
}

export type HostCloseReason =
  | 'connect_failed'
  | 'dead'
  | 'forced'
  | 'idle_ttl'
  | 'session_migration'
  | 'shutdown'
  | 'warm_cap';

export type HostRetirementReason =
  | 'launch_signature_mismatch'
  | 'login_identity_changed'
  | 'legacy_multi_affinity'
  | 'owner_unavailable'
  | 'direct_session_migration';

export interface HostResolution {
  entry: HostEntry | undefined;
  reusedSessionHost: boolean;
  retirement?: {
    entry: HostEntry;
    reason: HostRetirementReason;
  };
}

export function resolveHostEntry(
  entries: ReadonlySet<HostEntry>,
  sessionOwners: Map<string, HostEntry>,
  prepared: PreparedCodexHostLaunch,
  sessionId?: string,
): HostResolution {
  if (!sessionId) return findIdleHost(entries, sessionOwners, prepared);
  const owner = sessionOwners.get(sessionId);
  if (!owner) return findIdleHost(entries, sessionOwners, prepared);
  if (owner.lease?.sessionId === sessionId) {
    throw new Error(`Codex session ${sessionId} already has an active host lease`);
  }
  const mismatchReason = hostIdentityMismatch(owner, prepared);
  if (mismatchReason) {
    if (owner.attachmentCount > 0) {
      throw new Error(`Codex session ${sessionId} active host attachment launch contract mismatch`);
    }
    return retirement(owner, mismatchReason);
  }
  if (owner.state !== 'ready' || !owner.host.isAlive) {
    if (owner.attachmentCount > 0) {
      throw new Error(`Codex session ${sessionId} active host attachment is unavailable`);
    }
    return retirement(owner, 'owner_unavailable');
  }
  if (owner.lease || hasOtherSessionOwner(sessionOwners, owner, sessionId)) {
    if (owner.attachmentCount > 0) {
      throw new Error(`Codex session ${sessionId} active host attachment has conflicting affinity`);
    }
    return retirement(owner, 'legacy_multi_affinity');
  }
  return { entry: owner, reusedSessionHost: true };
}

/** Resolve the one host allowed to carry an attached control stream for a session. */
export function resolveHostAttachmentEntry(
  entries: ReadonlySet<HostEntry>,
  sessionOwners: Map<string, HostEntry>,
  prepared: PreparedCodexHostLaunch,
  sessionId: string,
): HostResolution {
  const owner = sessionOwners.get(sessionId);
  if (!owner) return findIdleHost(entries, sessionOwners, prepared);
  if (owner.attachmentCount > 0) {
    throw new Error(`Codex session ${sessionId} already has an active host attachment`);
  }
  if (owner.signature !== prepared.signature) {
    if (owner.lease?.sessionId === sessionId) {
      throw new Error(`Codex session ${sessionId} active writer launch contract mismatch`);
    }
    return retirement(owner, 'launch_signature_mismatch');
  }
  // Controls must still attach to a running writer after an external login.
  // Once it releases, idle attachments and the next turn use the new login.
  if (!owner.lease && owner.authIdentity !== prepared.authIdentity) {
    return retirement(owner, 'login_identity_changed');
  }
  if (owner.state !== 'ready' || !owner.host.isAlive) {
    if (owner.lease?.sessionId === sessionId) {
      throw new Error(`Codex session ${sessionId} active writer host is unavailable`);
    }
    return retirement(owner, 'owner_unavailable');
  }
  if ((owner.lease && owner.lease.sessionId !== sessionId) || hasOtherSessionOwner(sessionOwners, owner, sessionId)) {
    return retirement(owner, 'legacy_multi_affinity');
  }
  return { entry: owner, reusedSessionHost: true };
}

function hostIdentityMismatch(owner: HostEntry, prepared: PreparedCodexHostLaunch): HostRetirementReason | undefined {
  if (owner.signature !== prepared.signature) return 'launch_signature_mismatch';
  if (owner.authIdentity !== prepared.authIdentity) return 'login_identity_changed';
  return undefined;
}

function hasOtherSessionOwner(
  sessionOwners: ReadonlyMap<string, HostEntry>,
  owner: HostEntry,
  sessionId: string,
): boolean {
  for (const [candidateSessionId, candidateOwner] of sessionOwners) {
    if (candidateOwner === owner && candidateSessionId !== sessionId) return true;
  }
  return false;
}

function retirement(entry: HostEntry, reason: HostRetirementReason): HostResolution {
  return { entry: undefined, reusedSessionHost: false, retirement: { entry, reason } };
}

function findIdleHost(
  entries: ReadonlySet<HostEntry>,
  sessionOwners: ReadonlyMap<string, HostEntry>,
  prepared: PreparedCodexHostLaunch,
): HostResolution {
  const ownedEntries = new Set(sessionOwners.values());
  return {
    entry: [...entries].find(
      (entry) =>
        entry.signature === prepared.signature &&
        entry.authIdentity === prepared.authIdentity &&
        entry.state === 'ready' &&
        !entry.lease &&
        entry.attachmentCount === 0 &&
        entry.host.isAlive &&
        !ownedEntries.has(entry),
    ),
    reusedSessionHost: false,
  };
}

export async function waitForHostLeaseRelease(entry: HostEntry, signal?: AbortSignal): Promise<void> {
  if (!entry.lease) return;
  if (signal?.aborted) throw abortReason(signal);
  await new Promise<void>((resolve, reject) => {
    const released = (): void => {
      signal?.removeEventListener('abort', aborted);
      resolve();
    };
    const aborted = (): void => {
      entry.leaseReleaseWaiters.delete(released);
      reject(signal ? abortReason(signal) : new Error('Codex host retirement wait aborted'));
    };
    entry.leaseReleaseWaiters.add(released);
    signal?.addEventListener('abort', aborted, { once: true });
    if (!entry.lease && entry.leaseReleaseWaiters.delete(released)) released();
  });
}

export function notifyHostLeaseReleased(entry: HostEntry): void {
  const waiters = [...entry.leaseReleaseWaiters];
  entry.leaseReleaseWaiters.clear();
  for (const waiter of waiters) waiter();
}

interface CodexAppServerHostLeaseOptions {
  invocationId: string;
  sessionId?: string;
  signal?: AbortSignal;
  abortGraceMs?: number;
  onAbandoned(): Promise<void>;
}

/** Invocation-scoped ownership for one pooled Codex app-server host. */
export class CodexAppServerHostLease {
  readonly invocationId: string;
  sessionId: string | null;
  private readonly signal: AbortSignal | undefined;
  private readonly onAbandoned: () => Promise<void>;
  private readonly abortGraceMs: number;
  private abortTimer: ReturnType<typeof setTimeout> | null = null;
  private abortObservedValue = false;
  private readonly abortHandler: () => void;

  constructor(options: CodexAppServerHostLeaseOptions) {
    this.invocationId = options.invocationId;
    this.sessionId = normalizeSessionId(options.sessionId);
    this.signal = options.signal;
    this.onAbandoned = options.onAbandoned;
    this.abortGraceMs = Math.max(0, options.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS);
    this.abortHandler = () => this.armAbortFallback();
    if (this.signal?.aborted) this.armAbortFallback();
    else this.signal?.addEventListener('abort', this.abortHandler, { once: true });
  }

  bindSession(sessionId: string): boolean {
    const normalized = normalizeSessionId(sessionId);
    if (!normalized) return false;
    if (this.sessionId && this.sessionId !== normalized) return false;
    this.sessionId = normalized;
    return true;
  }

  /** Once cancellation reaches this lease, its provider host is never reusable. */
  get abortObserved(): boolean {
    return this.abortObservedValue;
  }

  dispose(): void {
    this.signal?.removeEventListener('abort', this.abortHandler);
    if (!this.abortTimer) return;
    clearTimeout(this.abortTimer);
    this.abortTimer = null;
  }

  private armAbortFallback(): void {
    this.abortObservedValue = true;
    if (this.abortTimer) return;
    this.abortTimer = setTimeout(() => {
      this.abortTimer = null;
      void this.onAbandoned().catch(() => {});
    }, this.abortGraceMs);
    this.abortTimer.unref?.();
  }
}

function normalizeSessionId(sessionId: string | undefined): string | null {
  const trimmed = sessionId?.trim();
  return trimmed || null;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Codex host retirement wait aborted');
}

/** Idle housekeeping never retires a host with an active lease or attachment. */
export function armCodexHostIdleTimer(entry: HostEntry, ttlMs: number, close: () => Promise<void>): NodeJS.Timeout {
  const timer = setTimeout(
    () => {
      if (!entry.lease && entry.attachmentCount === 0 && entry.state === 'ready') void close();
    },
    Math.max(0, ttlMs),
  );
  timer.unref?.();
  return timer;
}

export function clearCodexHostIdleTimer(entry: HostEntry): void {
  if (!entry.idleTimer) return;
  clearTimeout(entry.idleTimer);
  entry.idleTimer = null;
}
