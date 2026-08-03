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
}

export type HostCloseReason = 'connect_failed' | 'dead' | 'forced' | 'idle_ttl' | 'shutdown' | 'warm_cap';

export interface HostResolution {
  entry: HostEntry | undefined;
  reusedSessionHost: boolean;
}

export function resolveHostEntry(
  entries: ReadonlySet<HostEntry>,
  sessionOwners: Map<string, HostEntry>,
  signature: string,
  sessionId?: string,
): HostResolution {
  if (!sessionId) return findIdleHost(entries, signature);
  const owner = sessionOwners.get(sessionId);
  if (!owner) return findIdleHost(entries, signature);
  if (owner.signature !== signature || owner.state !== 'ready' || !owner.host.isAlive) {
    sessionOwners.delete(sessionId);
    return findIdleHost(entries, signature);
  }
  if (!owner.lease) return { entry: owner, reusedSessionHost: true };
  if (owner.lease.sessionId === sessionId) {
    throw new Error(`Codex session ${sessionId} already has an active host lease`);
  }
  sessionOwners.delete(sessionId);
  return findIdleHost(entries, signature);
}

function findIdleHost(entries: ReadonlySet<HostEntry>, signature: string): HostResolution {
  return {
    entry: [...entries].find(
      (entry) => entry.signature === signature && entry.state === 'ready' && !entry.lease && entry.host.isAlive,
    ),
    reusedSessionHost: false,
  };
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
    this.sessionId = normalized;
    return true;
  }

  dispose(): void {
    this.signal?.removeEventListener('abort', this.abortHandler);
    if (!this.abortTimer) return;
    clearTimeout(this.abortTimer);
    this.abortTimer = null;
  }

  private armAbortFallback(): void {
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
