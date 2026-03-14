/**
 * F048 Phase A: StartupReconciler
 *
 * On API startup, sweeps Redis for orphaned invocation records
 * left by a crashed/restarted process. Converges:
 * - running → failed(error=process_restart)
 * - stale queued (> 5min) → failed(error=process_restart)
 * Also clears associated TaskProgress snapshots.
 */

import type { CatId } from '@cat-cafe/shared';
import type { IInvocationRecordStore, InvocationRecord } from '../../stores/ports/InvocationRecordStore.js';
import type { AppendMessageInput } from '../../stores/ports/MessageStore.js';
import type { AgentMessage } from '../../types.js';
import type { TaskProgressStore } from './TaskProgressStore.js';

export interface StartupSweepResult {
  swept: number;
  running: number;
  queued: number;
  taskProgressCleared: number;
  notifiedThreads: number;
  durationMs: number;
}

interface ReconcilerLog {
  info(msg: string): void;
  warn(msg: string): void;
}

/** Minimal message-append interface (subset of IMessageStore). */
interface MessageAppender {
  append(msg: AppendMessageInput): unknown;
}

/** Minimal broadcast interface (subset of SocketManager). */
interface AgentMessageBroadcaster {
  broadcastAgentMessage(message: AgentMessage, threadId: string): void;
}

export interface StartupReconcilerDeps {
  invocationRecordStore: IInvocationRecordStore;
  taskProgressStore: TaskProgressStore;
  log: ReconcilerLog;
  /** Only sweep records created before this timestamp (prevents sweeping new invocations from current process). */
  processStartAt?: number;
  /** #77: Optional — post visible error messages to affected threads. */
  messageStore?: MessageAppender;
  /** #77: Optional — push real-time WebSocket notification to frontend. */
  socketManager?: AgentMessageBroadcaster;
}

type ScanStore = IInvocationRecordStore & { scanByStatus(status: string): Promise<string[]> };

/** Queued records older than this are considered stale after restart. */
const STALE_QUEUED_THRESHOLD_MS = 5 * 60 * 1000;

export class StartupReconciler {
  private readonly deps: StartupReconcilerDeps;

  constructor(deps: StartupReconcilerDeps) {
    this.deps = deps;
  }

  async reconcileOrphans(): Promise<StartupSweepResult> {
    const start = Date.now();
    const store = this.deps.invocationRecordStore;

    // Guard: only Redis-backed stores have scanByStatus
    // biome-ignore lint/complexity/useLiteralKeys: TS index signature requires bracket access
    if (!('scanByStatus' in store) || typeof (store as Record<string, unknown>)['scanByStatus'] !== 'function') {
      this.deps.log.info('[startup-reconciler] Memory mode — no orphans to sweep');
      return {
        swept: 0,
        running: 0,
        queued: 0,
        taskProgressCleared: 0,
        notifiedThreads: 0,
        durationMs: Date.now() - start,
      };
    }

    const scanStore = store as ScanStore;
    const affectedThreads = new Map<string, CatId[]>();
    const { running, taskProgressCleared } = await this.sweepRunning(
      scanStore,
      this.deps.processStartAt,
      affectedThreads,
    );
    const queued = await this.sweepStaleQueued(scanStore, affectedThreads);

    // #77: Notify affected threads with a visible error message
    const notifiedThreads = await this.notifyAffectedThreads(affectedThreads);

    const swept = running + queued;
    const durationMs = Date.now() - start;
    this.deps.log.info(
      `[startup-reconciler] Sweep complete: ${swept} orphans (${running} running, ${queued} stale queued), ` +
        `${taskProgressCleared} task-progress cleared, ${notifiedThreads} threads notified, ${durationMs}ms`,
    );
    return { swept, running, queued, taskProgressCleared, notifiedThreads, durationMs };
  }

  /** Sweep all running records — restart = all child processes dead. */
  private async sweepRunning(
    store: ScanStore,
    cutoff: number | undefined,
    affectedThreads: Map<string, CatId[]>,
  ): Promise<{ running: number; taskProgressCleared: number }> {
    let running = 0;
    let taskProgressCleared = 0;

    const ids = await store.scanByStatus('running');
    for (const id of ids) {
      try {
        const record = await store.get(id);
        if (!record) continue;
        // Skip records created after process started (they belong to this process, not orphans)
        if (cutoff && record.createdAt >= cutoff) continue;
        const updated = await store.update(id, {
          status: 'failed',
          expectedStatus: 'running',
          error: 'process_restart',
        });
        if (updated) {
          running++;
          this.trackAffectedThread(affectedThreads, record);
          taskProgressCleared += await this.clearTaskProgress(record.threadId, record.targetCats);
        }
      } catch (err) {
        this.deps.log.warn(`[startup-reconciler] Failed to sweep running invocation ${id}: ${String(err)}`);
      }
    }
    return { running, taskProgressCleared };
  }

  /** Sweep stale queued records (created > threshold ago). */
  private async sweepStaleQueued(store: ScanStore, affectedThreads: Map<string, CatId[]>): Promise<number> {
    let queued = 0;
    const ids = await store.scanByStatus('queued');
    const staleThreshold = Date.now() - STALE_QUEUED_THRESHOLD_MS;

    for (const id of ids) {
      try {
        const record = await store.get(id);
        if (!record || record.createdAt > staleThreshold) continue;
        const updated = await store.update(id, {
          status: 'failed',
          expectedStatus: 'queued',
          error: 'process_restart',
        });
        if (updated) {
          queued++;
          this.trackAffectedThread(affectedThreads, record);
        }
      } catch (err) {
        this.deps.log.warn(`[startup-reconciler] Failed to sweep queued invocation ${id}: ${String(err)}`);
      }
    }
    return queued;
  }

  /** Collect affected threadId → catIds for post-sweep notification. */
  private trackAffectedThread(map: Map<string, CatId[]>, record: InvocationRecord): void {
    const existing = map.get(record.threadId) ?? [];
    for (const catId of record.targetCats) {
      if (!existing.includes(catId)) existing.push(catId);
    }
    map.set(record.threadId, existing);
  }

  /** #77: Post a visible error message to each affected thread. */
  private async notifyAffectedThreads(affectedThreads: Map<string, CatId[]>): Promise<number> {
    if (affectedThreads.size === 0) return 0;
    const { messageStore, socketManager } = this.deps;
    if (!messageStore && !socketManager) return 0;

    let notified = 0;
    for (const [threadId, catIds] of affectedThreads) {
      try {
        const catLabel = catIds.length === 1 ? catIds[0] : `${catIds.length} cats`;
        const content = `Service restarted — interrupted in-progress request (${catLabel}). Please resend your message.`;

        if (messageStore) {
          await messageStore.append({
            threadId,
            userId: 'system',
            catId: null,
            content,
            mentions: [],
            timestamp: Date.now(),
          });
        }

        if (socketManager) {
          const errorCatId = catIds[0] ?? ('system' as CatId);
          socketManager.broadcastAgentMessage(
            { type: 'error', catId: errorCatId, error: content, isFinal: true, timestamp: Date.now() },
            threadId,
          );
        }

        notified++;
      } catch (err) {
        this.deps.log.warn(`[startup-reconciler] Failed to notify thread ${threadId}: ${String(err)}`);
      }
    }
    return notified;
  }

  /** Best-effort clear task progress for all target cats. */
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
}
