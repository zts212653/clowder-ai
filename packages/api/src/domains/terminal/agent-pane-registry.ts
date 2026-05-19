/**
 * AgentPaneRegistry — tracks which invocations are running in tmux panes,
 * and (F198 Phase C AC-C1) which bg carrier daemon sessions are running per thread.
 * In-memory store; used by terminal routes to let frontend discover agent panes.
 */

export type AgentPaneStatus = 'running' | 'done' | 'crashed';

export interface AgentPaneInfo {
  invocationId: string;
  worktreeId: string;
  paneId: string;
  userId: string;
  status: AgentPaneStatus;
  exitCode?: number | null;
  signal?: string | null;
  startedAt: number;
  finishedAt?: number;
}

const STALE_THRESHOLD_MS = 3_600_000; // 1 hour after finishing

/** F198 Phase C: metadata for a bg carrier daemon session. */
export interface BgCarrierSessionInfo {
  invocationId: string;
  catId: string;
  daemonShortId: string;
  threadId: string;
  status: 'running' | 'done';
  startedAt: number;
  finishedAt?: number;
}

export class AgentPaneRegistry {
  private panes = new Map<string, AgentPaneInfo>();
  /** F198 Phase C AC-C1: bg carrier sessions keyed by invocationId. */
  private bgCarrierSessions = new Map<string, BgCarrierSessionInfo>();

  register(invocationId: string, worktreeId: string, paneId: string, userId: string): void {
    this.panes.set(invocationId, {
      invocationId,
      worktreeId,
      paneId,
      userId,
      status: 'running',
      startedAt: Date.now(),
    });
    this.evictStale();
  }

  getByInvocation(invocationId: string): AgentPaneInfo | undefined {
    return this.panes.get(invocationId);
  }

  listByWorktreeAndUser(worktreeId: string, userId: string): AgentPaneInfo[] {
    const now = Date.now();
    return Array.from(this.panes.values()).filter(
      (p) =>
        p.worktreeId === worktreeId &&
        p.userId === userId &&
        (p.status === 'running' || !p.finishedAt || now - p.finishedAt < STALE_THRESHOLD_MS),
    );
  }

  /** Remove terminal entries (done/crashed) older than threshold since finishing */
  private evictStale(): void {
    const now = Date.now();
    for (const [id, p] of this.panes) {
      if (p.status !== 'running' && p.finishedAt && now - p.finishedAt > STALE_THRESHOLD_MS) {
        this.panes.delete(id);
      }
    }
  }

  markDone(invocationId: string, exitCode: number | null): void {
    const p = this.panes.get(invocationId);
    if (p) {
      p.status = 'done';
      p.exitCode = exitCode;
      p.finishedAt = Date.now();
    }
  }

  markCrashed(invocationId: string, signal: string | null): void {
    const p = this.panes.get(invocationId);
    if (p) {
      p.status = 'crashed';
      p.signal = signal;
      p.finishedAt = Date.now();
    }
  }

  remove(invocationId: string): void {
    this.panes.delete(invocationId);
  }

  // ── F198 Phase C AC-C1: bg carrier session tracking ──────────────────────

  registerBgCarrier(opts: { invocationId: string; catId: string; daemonShortId: string; threadId: string }): void {
    this.bgCarrierSessions.set(opts.invocationId, {
      ...opts,
      status: 'running',
      startedAt: Date.now(),
    });
  }

  getBgCarrierByInvocation(invocationId: string): BgCarrierSessionInfo | undefined {
    return this.bgCarrierSessions.get(invocationId);
  }

  /** Returns the most-recently-started running bg carrier session for a thread. */
  getBgCarrierByThread(threadId: string): BgCarrierSessionInfo | undefined {
    let latest: BgCarrierSessionInfo | undefined;
    for (const session of this.bgCarrierSessions.values()) {
      if (session.threadId === threadId && session.status === 'running') {
        if (!latest || session.startedAt > latest.startedAt) {
          latest = session;
        }
      }
    }
    return latest;
  }

  markBgCarrierDone(invocationId: string): void {
    const session = this.bgCarrierSessions.get(invocationId);
    if (session) {
      session.status = 'done';
      session.finishedAt = Date.now();
    }
  }

  /** P1-2: Set of all daemonShortIds known to Clowder AI (running + done). Used to scope /api/agent-sessions. */
  getRegisteredDaemonShortIds(): Set<string> {
    const ids = new Set<string>();
    for (const session of this.bgCarrierSessions.values()) {
      ids.add(session.daemonShortId);
    }
    return ids;
  }
}
