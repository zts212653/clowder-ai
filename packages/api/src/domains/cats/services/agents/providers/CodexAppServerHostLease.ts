import type { CodexAppServerHostProcess } from './CodexUnixWebSocketSession.js';

const DEFAULT_ABORT_GRACE_MS = 5_000;

export interface HostEntry {
  signature: string;
  host: CodexAppServerHostProcess;
  socketDirectory: string;
  state: 'ready' | 'closing';
  lease: CodexAppServerHostLease | null;
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

export type HostRetirementReason = 'launch_signature_mismatch' | 'legacy_multi_affinity' | 'owner_unavailable';

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
  signature: string,
  sessionId?: string,
): HostResolution {
  if (!sessionId) return findIdleHost(entries, sessionOwners, signature);
  const owner = sessionOwners.get(sessionId);
  if (!owner) return findIdleHost(entries, sessionOwners, signature);
  if (owner.lease?.sessionId === sessionId) {
    throw new Error(`Codex session ${sessionId} already has an active host lease`);
  }
  if (owner.signature !== signature) return retirement(owner, 'launch_signature_mismatch');
  if (owner.state !== 'ready' || !owner.host.isAlive) return retirement(owner, 'owner_unavailable');
  if (owner.lease || hasOtherSessionOwner(sessionOwners, owner, sessionId)) {
    return retirement(owner, 'legacy_multi_affinity');
  }
  return { entry: owner, reusedSessionHost: true };
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
  signature: string,
): HostResolution {
  const ownedEntries = new Set(sessionOwners.values());
  return {
    entry: [...entries].find(
      (entry) =>
        entry.signature === signature &&
        entry.state === 'ready' &&
        !entry.lease &&
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
