import {
  codexAppServerForcedCleanup,
  codexAppServerInterrupt,
  codexAppServerLifecycleTransition,
  codexAppServerStageDuration,
} from '../../../../../infrastructure/telemetry/instruments.js';
import type { AgentCarrierSession } from '../../types.js';
import type { CodexAppServerJsonObject } from './CodexAppServerEventMapper.js';

export type CodexAppServerLifecycleStage =
  | 'child_spawned'
  | 'initialized'
  | 'thread_ready'
  | 'turn_accepted'
  | 'active'
  | 'completed'
  | 'interrupted'
  | 'failed'
  | 'closing'
  | 'closed';

export interface CodexAppServerLifecycleSnapshot {
  stage: CodexAppServerLifecycleStage;
  lastActivityAt: number;
  recoveryAttempt: number;
  threadId?: string;
  turnId?: string;
  turnStartSent: boolean;
  turnAccepted: boolean;
  itemObserved: boolean;
  toolSurfaceObserved: boolean;
  interruptReason?: 'user_cancel' | 'timeout';
  failureReason?: string;
  cleanupError?: string;
}

export interface CodexAppServerLifecycleEvent {
  type: 'app_server.lifecycle';
  lifecycle: CodexAppServerLifecycleSnapshot;
}

interface CodexAppServerLifecycleDeps {
  wire: AgentCarrierSession;
  request(method: string, params: CodexAppServerJsonObject): Promise<unknown>;
  onLifecycle?: (snapshot: CodexAppServerLifecycleSnapshot) => void;
  now?: () => number;
}

export class CodexAppServerLifecycle {
  private current: CodexAppServerLifecycleSnapshot | null = null;
  private stageEnteredAt = 0;
  private inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  private interruptGraceTimer: ReturnType<typeof setTimeout> | null = null;
  private interruptRequested = false;
  private terminalReached = false;
  private forceTerminationPromise: Promise<void> | null = null;

  constructor(private readonly deps: CodexAppServerLifecycleDeps) {}

  transition(
    stage: CodexAppServerLifecycleStage,
    patch?: Partial<CodexAppServerLifecycleSnapshot>,
  ): CodexAppServerLifecycleSnapshot {
    const previous = this.current;
    const now = this.now();
    if (previous && previous.stage === stage) {
      this.current = { ...previous, ...patch, lastActivityAt: now };
      this.emit();
      return this.snapshot();
    }
    if (previous) {
      codexAppServerStageDuration.record(Math.max(0, now - this.stageEnteredAt) / 1_000, { status: previous.stage });
    }
    this.stageEnteredAt = now;
    this.current = {
      stage,
      lastActivityAt: now,
      recoveryAttempt: patch?.recoveryAttempt ?? previous?.recoveryAttempt ?? 0,
      turnStartSent: patch?.turnStartSent ?? previous?.turnStartSent ?? false,
      turnAccepted: patch?.turnAccepted ?? previous?.turnAccepted ?? false,
      itemObserved: patch?.itemObserved ?? previous?.itemObserved ?? false,
      toolSurfaceObserved: patch?.toolSurfaceObserved ?? previous?.toolSurfaceObserved ?? false,
      ...(previous?.threadId ? { threadId: previous.threadId } : {}),
      ...(previous?.turnId ? { turnId: previous.turnId } : {}),
      ...(previous?.interruptReason ? { interruptReason: previous.interruptReason } : {}),
      ...(previous?.failureReason ? { failureReason: previous.failureReason } : {}),
      ...(previous?.cleanupError ? { cleanupError: previous.cleanupError } : {}),
      ...(patch ?? {}),
    };
    codexAppServerLifecycleTransition.add(1, { status: stage });
    this.emit();
    return this.snapshot();
  }

  patch(patch: Partial<CodexAppServerLifecycleSnapshot>): void {
    if (!this.current) return;
    this.current = { ...this.current, ...patch, lastActivityAt: this.now() };
    this.emit();
  }

  touch(timeoutMs: number, onTimeout: () => void): CodexAppServerLifecycleSnapshot {
    if (!this.current) throw new Error('Codex app-server lifecycle was not initialized');
    this.current = { ...this.current, lastActivityAt: this.now() };
    this.emit();
    this.armInactivityTimeout(timeoutMs, onTimeout);
    return this.snapshot();
  }

  snapshot(): CodexAppServerLifecycleSnapshot {
    if (!this.current) throw new Error('Codex app-server lifecycle was not initialized');
    return { ...this.current };
  }

  event(snapshot = this.snapshot()): CodexAppServerLifecycleEvent {
    return { type: 'app_server.lifecycle', lifecycle: snapshot };
  }

  armInactivityTimeout(timeoutMs: number, onTimeout: () => void): void {
    if (timeoutMs <= 0 || this.interruptRequested || this.terminalReached) return;
    if (this.inactivityTimer) clearTimeout(this.inactivityTimer);
    this.inactivityTimer = setTimeout(onTimeout, timeoutMs);
  }

  async interrupt(
    threadId: string | null,
    turnId: string | null,
    reason: 'user_cancel' | 'timeout',
    interruptGraceMs: number,
  ): Promise<void> {
    if (this.interruptRequested || this.terminalReached) return;
    this.interruptRequested = true;
    if (this.inactivityTimer) clearTimeout(this.inactivityTimer);
    this.inactivityTimer = null;
    this.patch({ interruptReason: reason });
    codexAppServerInterrupt.add(1, { 'signal.kind': reason });
    if (!threadId || !turnId) {
      await this.forceTerminate('missing_protocol_ids');
      return;
    }
    void this.deps
      .request('turn/interrupt', { threadId, turnId })
      .catch(() => this.forceTerminate('interrupt_rpc_failed'))
      .catch(() => {});
    this.interruptGraceTimer = setTimeout(() => {
      void this.forceTerminate('interrupt_grace_expired').catch(() => {});
    }, interruptGraceMs);
  }

  markAuthoritativeTerminal(): void {
    this.terminalReached = true;
    this.clearTimers();
  }

  transitionToFailure(failureReason: string): CodexAppServerLifecycleSnapshot | null {
    if (this.terminalReached) return null;
    this.terminalReached = true;
    this.clearTimers();
    return this.transition('failed', { failureReason });
  }

  recordCleanupFailure(): void {
    codexAppServerForcedCleanup.add(1, { status: 'close_failed' });
  }

  clearTimers(): void {
    if (this.inactivityTimer) clearTimeout(this.inactivityTimer);
    if (this.interruptGraceTimer) clearTimeout(this.interruptGraceTimer);
    this.inactivityTimer = null;
    this.interruptGraceTimer = null;
  }

  private async forceTerminate(status: string): Promise<void> {
    if (this.terminalReached) return;
    if (this.forceTerminationPromise) return this.forceTerminationPromise;
    codexAppServerForcedCleanup.add(1, { status });
    const action = this.deps.wire.terminate ? this.deps.wire.terminate() : this.deps.wire.close();
    this.forceTerminationPromise = action;
    try {
      await action;
    } catch (error) {
      this.forceTerminationPromise = null;
      throw error;
    }
  }

  private emit(): void {
    if (!this.current) return;
    try {
      this.deps.onLifecycle?.({ ...this.current });
    } catch {
      // Lifecycle projection is observational; it cannot abort provider work.
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}
