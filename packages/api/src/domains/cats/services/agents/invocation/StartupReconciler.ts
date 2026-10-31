/**
 * F048 Phase A + A+: StartupReconciler
 *
 * On API startup, sweeps Redis for orphaned invocation records
 * left by a crashed/restarted process. Converges:
 * - running → failed(error=process_restart)
 * - stale queued (> 5min) → failed(error=process_restart)
 * Also clears associated TaskProgress snapshots.
 *
 * The parent/auth record is only a projection: child recovery owns the exact
 * response result, and pending Queue entries resume from their durable ledger.
 */

import type { CatId } from '@cat-cafe/shared';
import type { IBallCustodyIngest } from '../../../../ball-custody/BallCustodyIngest.js';
import { buildInvocationDiedEvent } from '../../../../ball-custody/ball-custody-events.js';
import type { IInvocationRecordStore, InvocationRecord } from '../../stores/ports/InvocationRecordStore.js';
import type { AppendMessageInput } from '../../stores/ports/MessageStore.js';
import type { ITurnExecutionStore } from '../../stores/ports/TurnExecutionStore.js';
import type { InvocationQueue } from './InvocationQueue.js';
import type { TaskProgressStore } from './TaskProgressStore.js';

export interface StartupSweepResult {
  swept: number;
  running: number;
  queued: number;
  taskProgressCleared: number;
  /** Queued user messages made visible after orphan sweep. */
  messagesRecovered: number;
  notifiedThreads: number;
  queueEntriesRestored: number;
  queueEntriesResumed: number;
  /** Durable Queue scopes that remain eligible after reconciliation, whether resumed here or by the caller. */
  queueResumeScopes: Array<{ threadId: string; userId: string }>;
  queueMessagesBackfilled: number;
  queueMessagesTerminalized: number;
  durationMs: number;
}

interface ReconcilerLog {
  info(msg: string): void;
  warn(msg: string): void;
}

interface MessageAppender {
  append(msg: AppendMessageInput): unknown;
  /** Mark a queued message as delivered (make visible in timeline). */
  markDelivered?(id: string, deliveredAt: number): unknown;
}

interface ConnectorMessageBroadcaster {
  broadcastToRoom(room: string, event: string, data: unknown): void;
}

export interface StartupReconcilerDeps {
  invocationRecordStore: IInvocationRecordStore;
  /** Durable child lifecycle truth used to reconcile callback-auth projection state. */
  turnExecutionStore?: ITurnExecutionStore;
  taskProgressStore: TaskProgressStore;
  log: ReconcilerLog;
  /** Only sweep records created before this timestamp (prevents sweeping new invocations from current process). */
  processStartAt?: number;
  /** Optional legacy message visibility projection; never append a recovery result. */
  messageStore?: MessageAppender;
  /** Retained composition option; recovery does not publish an independent chat notice. */
  socketManager?: ConnectorMessageBroadcaster;
  /** Optional observability ledger for restart-killed running invocations. */
  ballCustody?: IBallCustodyIngest;
  /** Exact in-memory projection hydrated from the canonical durable Queue ledger. */
  invocationQueue?: InvocationQueue;
  /** F254: natural next-spawn hook, invoked once for each newly restored queue scope. */
  resumeQueue?: (threadId: string, userId: string) => Promise<unknown>;
}

type ScanStore = IInvocationRecordStore & { scanByStatus(status: string): Promise<string[]> };

const STALE_QUEUED_THRESHOLD_MS = 5 * 60 * 1000;
const CHILD_STATUSES = new Set(['running', 'succeeded', 'failed', 'canceled', 'interrupted']);

export class StartupReconciler {
  private readonly deps: StartupReconcilerDeps;

  constructor(deps: StartupReconcilerDeps) {
    this.deps = deps;
  }

  async reconcileOrphans(): Promise<StartupSweepResult> {
    const start = Date.now();
    const store = this.deps.invocationRecordStore;

    // biome-ignore lint/complexity/useLiteralKeys: TS index signature requires bracket access
    if (!('scanByStatus' in store) || typeof (store as Record<string, unknown>)['scanByStatus'] !== 'function') {
      this.deps.log.info('[startup-reconciler] Memory mode — no orphans to sweep');
      return {
        swept: 0,
        running: 0,
        queued: 0,
        taskProgressCleared: 0,
        messagesRecovered: 0,
        notifiedThreads: 0,
        queueEntriesRestored: 0,
        queueEntriesResumed: 0,
        queueResumeScopes: [],
        queueMessagesBackfilled: 0,
        queueMessagesTerminalized: 0,
        durationMs: Date.now() - start,
      };
    }

    const scanStore = store as ScanStore;
    const runResult = await this.sweepRunning(scanStore, this.deps.processStartAt);
    const queueResult = await this.sweepStaleQueued(scanStore);

    // ADR-043: Queue rows were hydrated directly from the durable ledger before
    // this sweep. Atomic message+row admission makes orphan-message recovery and
    // message-custody reconstruction unnecessary.
    const orphanedMessageRecovery = 0;
    const queueResumeScopes = this.deps.invocationQueue?.listScopes() ?? [];
    let queueEntriesResumed = 0;
    if (this.deps.resumeQueue) {
      for (const scope of queueResumeScopes) {
        try {
          await this.deps.resumeQueue(scope.threadId, scope.userId);
          queueEntriesResumed += 1;
        } catch (err) {
          this.deps.log.warn(
            `[startup-reconciler] Failed to resume durable Queue scope ${scope.threadId}/${scope.userId}: ${String(err)}`,
          );
        }
      }
    }

    // Canonical child recovery settles the original response. Parent/auth projection
    // recovery never creates a second History result or a socket-only chat notice.
    const notifiedThreads = 0;

    const running = runResult.running;
    const queued = queueResult.queued;
    const taskProgressCleared = runResult.taskProgressCleared;
    const messagesRecovered = runResult.messagesRecovered + queueResult.messagesRecovered + orphanedMessageRecovery;
    const swept = running + queued;
    const durationMs = Date.now() - start;
    this.deps.log.info(
      `[startup-reconciler] Sweep complete: ${swept} orphans (${running} running, ${queued} stale queued), ` +
        `${taskProgressCleared} task-progress cleared, ${messagesRecovered} messages recovered, ` +
        `${notifiedThreads} threads notified, ${durationMs}ms`,
    );
    return {
      swept,
      running,
      queued,
      taskProgressCleared,
      messagesRecovered,
      notifiedThreads,
      queueEntriesRestored: queueResumeScopes.length,
      queueEntriesResumed,
      queueResumeScopes,
      queueMessagesBackfilled: 0,
      // Compatibility counter: schema v2 never persists processing/terminal Queue rows.
      queueMessagesTerminalized: 0,
      durationMs,
    };
  }

  private async sweepRunning(
    store: ScanStore,
    cutoff: number | undefined,
  ): Promise<{ running: number; taskProgressCleared: number; messagesRecovered: number }> {
    let running = 0;
    let taskProgressCleared = 0;
    let messagesRecovered = 0;

    const ids = await store.scanByStatus('running');
    for (const id of ids) {
      try {
        const record = await store.get(id);
        if (!record) continue;
        if (cutoff && record.createdAt >= cutoff) continue;
        if (await this.hasRunningChild(record)) continue;
        const lastScanAt = record.updatedAt;
        const updated = await store.update(id, {
          status: 'failed',
          expectedStatus: 'running',
          error: 'process_restart',
        });
        if (updated) {
          running++;
          this.recordInvocationDied(record, lastScanAt);
          taskProgressCleared += await this.clearTaskProgress(record.threadId, record.targetCats);
          // Safe: markDelivered is a no-op for non-queued messages (undefined/delivered/canceled),
          // so already-visible messages won't be re-scored. Only catches the edge case where
          // process crashed between invocation→running and markDelivered.
          if (await this.ensureMessageVisible(record)) messagesRecovered++;
        }
      } catch (err) {
        this.deps.log.warn(`[startup-reconciler] Failed to sweep running invocation ${id}: ${String(err)}`);
      }
    }
    return { running, taskProgressCleared, messagesRecovered };
  }

  private recordInvocationDied(record: InvocationRecord, lastScanAt: number): void {
    const catId = record.targetCats.length === 1 ? record.targetCats[0] : undefined;
    this.deps.ballCustody
      ?.record(
        buildInvocationDiedEvent({
          invocationId: record.id,
          threadId: record.threadId,
          ...(catId ? { catId } : {}),
          reason: 'process_restart',
          lastScanAt,
          at: Date.now(),
        }),
      )
      .catch((err) =>
        this.deps.log.warn(`[startup-reconciler] Failed to record invocation.died for ${record.id}: ${String(err)}`),
      );
  }

  private async sweepStaleQueued(store: ScanStore): Promise<{ queued: number; messagesRecovered: number }> {
    let queued = 0;
    let messagesRecovered = 0;
    const ids = await store.scanByStatus('queued');
    const staleThreshold = Date.now() - STALE_QUEUED_THRESHOLD_MS;

    for (const id of ids) {
      try {
        const record = await store.get(id);
        if (!record || record.createdAt > staleThreshold) continue;
        if (await this.hasRunningChild(record)) continue;
        const updated = await store.update(id, {
          status: 'failed',
          expectedStatus: 'queued',
          error: 'process_restart',
        });
        if (updated) {
          queued++;
          if (await this.ensureMessageVisible(record)) messagesRecovered++;
        }
      } catch (err) {
        this.deps.log.warn(`[startup-reconciler] Failed to sweep queued invocation ${id}: ${String(err)}`);
      }
    }
    return { queued, messagesRecovered };
  }

  private async hasRunningChild(record: InvocationRecord): Promise<boolean> {
    // Legacy callers without a child ledger retain their existing orphan sweep.
    // Production supplies this ledger: unavailable or inconsistent truth must
    // leave the callback-auth projection and its progress untouched.
    if (!this.deps.turnExecutionStore) return false;
    const children = await this.deps.turnExecutionStore.listByParent(record.id);
    for (const child of children) {
      if (
        child.parentInvocationId !== record.id ||
        child.threadId !== record.threadId ||
        child.userId !== record.userId ||
        !record.targetCats.includes(child.catId)
      ) {
        throw new Error(`Child identity mismatch for parent ${record.id}`);
      }
      if (!CHILD_STATUSES.has(child.status)) {
        throw new Error(`Unknown child lifecycle for parent ${record.id}`);
      }
    }
    return children.some((child) => child.status === 'running');
  }

  private async clearTaskProgress(threadId: string, targetCats: CatId[]): Promise<number> {
    let cleared = 0;
    for (const catId of targetCats) {
      try {
        await this.deps.taskProgressStore.deleteSnapshot(threadId, catId);
        cleared++;
      } catch {
        /* best-effort */
      }
    }
    return cleared;
  }

  private isDurableQueuedMessage(threadId: string, messageId: string | null): boolean {
    if (!this.deps.invocationQueue || !messageId) return false;
    return this.deps.invocationQueue.findEntryWithMessageId(threadId, messageId)?.status === 'queued';
  }

  /**
   * P1-C: Make queued user messages visible after orphan invocation sweep.
   * Without this, messages with deliveryStatus='queued' stay invisible in timeline/context
   * after a process_restart, because markDelivered() was never called.
   */
  private async ensureMessageVisible(record: InvocationRecord): Promise<boolean> {
    const { messageStore } = this.deps;
    if (!messageStore?.markDelivered || !record.userMessageId) return false;
    if (this.isDurableQueuedMessage(record.threadId, record.userMessageId)) return false;
    try {
      const result = await messageStore.markDelivered(record.userMessageId, Date.now());
      if (result && typeof result === 'object' && 'deliveryTransitioned' in result) {
        return (result as { deliveryTransitioned?: boolean }).deliveryTransitioned === true;
      }
      return result != null;
    } catch (err) {
      this.deps.log.warn(
        `[startup-reconciler] Failed to recover message ${record.userMessageId} for invocation ${record.id}: ${String(err)}`,
      );
      return false;
    }
  }
}
