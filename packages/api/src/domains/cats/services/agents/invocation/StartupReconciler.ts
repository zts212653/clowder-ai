/**
 * F048 Phase A + A+: StartupReconciler
 *
 * On API startup, sweeps Redis for orphaned invocation records
 * left by a crashed/restarted process. Converges:
 * - running → failed(error=process_restart)
 * - stale queued (> 5min) → failed(error=process_restart)
 * Also clears associated TaskProgress snapshots.
 *
 * Phase A+: Posts visible error messages to affected threads
 * so users know their request was interrupted.
 * (Intake from community PR #78 / Issue #77, with source field fix.)
 */

import { randomUUID } from 'node:crypto';
import type { CatId, ConnectorSource } from '@cat-cafe/shared';
import type { IInvocationRecordStore, InvocationRecord } from '../../stores/ports/InvocationRecordStore.js';
import type { AppendMessageInput } from '../../stores/ports/MessageStore.js';
import type { TaskProgressStore } from './TaskProgressStore.js';

export interface StartupSweepResult {
  swept: number;
  running: number;
  queued: number;
  taskProgressCleared: number;
  /** Queued user messages made visible after orphan sweep. */
  messagesRecovered: number;
  notifiedThreads: number;
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

const RECONCILER_SOURCE: ConnectorSource = {
  connector: 'startup-reconciler',
  label: '重启通知',
  icon: '⚠️',
  meta: { presentation: 'system_notice', noticeTone: 'warning' },
};

export interface StartupReconcilerDeps {
  invocationRecordStore: IInvocationRecordStore;
  taskProgressStore: TaskProgressStore;
  log: ReconcilerLog;
  /** Only sweep records created before this timestamp (prevents sweeping new invocations from current process). */
  processStartAt?: number;
  /** Phase A+: Optional — post visible error messages to affected threads. */
  messageStore?: MessageAppender;
  /** Phase A+: Optional — push real-time WebSocket notification to frontend. */
  socketManager?: ConnectorMessageBroadcaster;
}

type ScanStore = IInvocationRecordStore & { scanByStatus(status: string): Promise<string[]> };

const STALE_QUEUED_THRESHOLD_MS = 5 * 60 * 1000;

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
        durationMs: Date.now() - start,
      };
    }

    const scanStore = store as ScanStore;
    const affectedThreads = new Map<string, { catIds: CatId[]; userId: string }>();
    const runResult = await this.sweepRunning(scanStore, this.deps.processStartAt, affectedThreads);
    const queueResult = await this.sweepStaleQueued(scanStore, affectedThreads);

    const notifiedThreads = await this.notifyAffectedThreads(affectedThreads);

    const running = runResult.running;
    const queued = queueResult.queued;
    const taskProgressCleared = runResult.taskProgressCleared;
    const messagesRecovered = runResult.messagesRecovered + queueResult.messagesRecovered;
    const swept = running + queued;
    const durationMs = Date.now() - start;
    this.deps.log.info(
      `[startup-reconciler] Sweep complete: ${swept} orphans (${running} running, ${queued} stale queued), ` +
        `${taskProgressCleared} task-progress cleared, ${messagesRecovered} messages recovered, ` +
        `${notifiedThreads} threads notified, ${durationMs}ms`,
    );
    return { swept, running, queued, taskProgressCleared, messagesRecovered, notifiedThreads, durationMs };
  }

  private async sweepRunning(
    store: ScanStore,
    cutoff: number | undefined,
    affectedThreads: Map<string, { catIds: CatId[]; userId: string }>,
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
        const updated = await store.update(id, {
          status: 'failed',
          expectedStatus: 'running',
          error: 'process_restart',
        });
        if (updated) {
          running++;
          this.trackAffectedThread(affectedThreads, record);
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

  private async sweepStaleQueued(
    store: ScanStore,
    affectedThreads: Map<string, { catIds: CatId[]; userId: string }>,
  ): Promise<{ queued: number; messagesRecovered: number }> {
    let queued = 0;
    let messagesRecovered = 0;
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
          if (await this.ensureMessageVisible(record)) messagesRecovered++;
        }
      } catch (err) {
        this.deps.log.warn(`[startup-reconciler] Failed to sweep queued invocation ${id}: ${String(err)}`);
      }
    }
    return { queued, messagesRecovered };
  }

  private trackAffectedThread(map: Map<string, { catIds: CatId[]; userId: string }>, record: InvocationRecord): void {
    const existing = map.get(record.threadId) ?? { catIds: [], userId: record.userId };
    for (const catId of record.targetCats) {
      if (!existing.catIds.includes(catId)) existing.catIds.push(catId);
    }
    map.set(record.threadId, existing);
  }

  private async notifyAffectedThreads(
    affectedThreads: Map<string, { catIds: CatId[]; userId: string }>,
  ): Promise<number> {
    if (affectedThreads.size === 0) return 0;
    const { messageStore, socketManager } = this.deps;
    if (!messageStore && !socketManager) return 0;

    let notified = 0;
    for (const [threadId, { catIds, userId }] of affectedThreads) {
      const catLabel = catIds.length === 1 ? catIds[0] : `${catIds.length} cats`;
      const content = `服务刚重启，${catLabel} 的进行中请求已中断，请重新发送。`;
      const fallbackId = `startup-reconciler-${threadId}-${randomUUID().slice(0, 8)}`;
      let messageId = fallbackId;
      let timestamp = Date.now();

      let persisted = false;
      let broadcasted = false;
      if (messageStore) {
        try {
          const stored = await messageStore.append({
            threadId,
            userId,
            catId: null,
            content,
            mentions: [],
            source: RECONCILER_SOURCE,
            timestamp,
          });
          if (stored && typeof stored === 'object') {
            const maybeStored = stored as { id?: unknown; timestamp?: unknown };
            if (typeof maybeStored.id === 'string') messageId = maybeStored.id;
            if (typeof maybeStored.timestamp === 'number') timestamp = maybeStored.timestamp;
          }
          persisted = true;
        } catch (err) {
          this.deps.log.warn(
            `[startup-reconciler] Failed to persist notification for thread ${threadId}: ${String(err)}`,
          );
        }
      }

      if (socketManager) {
        try {
          socketManager.broadcastToRoom(`thread:${threadId}`, 'connector_message', {
            threadId,
            message: {
              id: messageId,
              type: 'connector' as const,
              content,
              source: RECONCILER_SOURCE,
              timestamp,
            },
          });
          broadcasted = true;
        } catch (err) {
          this.deps.log.warn(
            `[startup-reconciler] Failed to broadcast notification for thread ${threadId}: ${String(err)}`,
          );
        }
      }

      if (persisted || broadcasted) notified++;
    }
    return notified;
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

  /**
   * P1-C: Make queued user messages visible after orphan invocation sweep.
   * Without this, messages with deliveryStatus='queued' stay invisible in timeline/context
   * after a process_restart, because markDelivered() was never called.
   */
  private async ensureMessageVisible(record: InvocationRecord): Promise<boolean> {
    const { messageStore } = this.deps;
    if (!messageStore?.markDelivered || !record.userMessageId) return false;
    try {
      const result = await messageStore.markDelivered(record.userMessageId, Date.now());
      return result != null;
    } catch (err) {
      this.deps.log.warn(
        `[startup-reconciler] Failed to recover message ${record.userMessageId} for invocation ${record.id}: ${String(err)}`,
      );
      return false;
    }
  }
}
