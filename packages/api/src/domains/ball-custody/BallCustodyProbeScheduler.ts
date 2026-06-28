import type { BallCustodyProjection, TaskItem } from '@cat-cafe/shared';
import type { ITaskStore } from '../cats/services/stores/ports/TaskStore.js';
import type { IBallCustodyIngest } from './BallCustodyIngest.js';
import type { IBallCustodyProjectionStore } from './BallCustodyProjectionStore.js';
import { buildTaskIdleLongEvent, buildWakeSentEvent } from './ball-custody-events.js';

export interface BallCustodyProbeResult {
  readonly satisfied: boolean;
  readonly reason?: string;
}

export interface BallCustodyProbeEvaluator {
  evaluate(input: { task: TaskItem; projection: BallCustodyProjection }): Promise<BallCustodyProbeResult>;
}

export interface BallCustodyWakeSender {
  send(input: { task: TaskItem; projection: BallCustodyProjection; at: number }): Promise<{ messageId: string }>;
}

export interface BallCustodyProbeSchedulerOptions {
  readonly projectionStore: IBallCustodyProjectionStore;
  readonly taskStore: Pick<ITaskStore, 'get' | 'update'>;
  readonly ballCustody: IBallCustodyIngest;
  readonly probeEvaluator: BallCustodyProbeEvaluator;
  readonly wakeSender: BallCustodyWakeSender;
  readonly now?: () => number;
  readonly wakeCooldownMs?: number;
  readonly idleLongMs?: number;
  readonly logger?: {
    warn?: (obj: unknown, msg?: string) => void;
    error?: (obj: unknown, msg?: string) => void;
    info?: (obj: unknown, msg?: string) => void;
  };
}

export interface BallCustodyProbeTickResult {
  checked: number;
  completed: number;
  woken: number;
  idleMarked: number;
  cooldownSkipped: number;
  skipped: number;
  failed: number;
}

const DEFAULT_WAKE_COOLDOWN_MS = 12 * 60 * 60 * 1000;
const DEFAULT_IDLE_LONG_MS = 30 * 24 * 60 * 60 * 1000;
const IDLE_LONG_STATES = new Set(['active', 'blocked', 'parked', 'void']);

function taskIdFromSubject(subjectKey: string): string | null {
  const prefix = 'ball:task:';
  if (!subjectKey.startsWith(prefix)) return null;
  const taskId = subjectKey.slice(prefix.length);
  return taskId.length > 0 ? taskId : null;
}

export class BallCustodyProbeScheduler {
  private readonly now: () => number;
  private readonly wakeCooldownMs: number;
  private readonly idleLongMs: number;
  private readonly deliveredWakeAtByEpisode = new Map<string, number>();

  constructor(private readonly opts: BallCustodyProbeSchedulerOptions) {
    this.now = opts.now ?? Date.now;
    this.wakeCooldownMs = opts.wakeCooldownMs ?? DEFAULT_WAKE_COOLDOWN_MS;
    this.idleLongMs = opts.idleLongMs ?? DEFAULT_IDLE_LONG_MS;
  }

  async tick(): Promise<BallCustodyProbeTickResult> {
    const result: BallCustodyProbeTickResult = {
      checked: 0,
      completed: 0,
      woken: 0,
      idleMarked: 0,
      cooldownSkipped: 0,
      skipped: 0,
      failed: 0,
    };

    const subjectKeys = await this.opts.projectionStore.listSubjectKeys();
    for (const subjectKey of subjectKeys) {
      await this.processSubject(subjectKey, result);
    }
    return result;
  }

  private async processSubject(subjectKey: string, result: BallCustodyProbeTickResult): Promise<void> {
    const taskId = taskIdFromSubject(subjectKey);
    if (!taskId) {
      result.skipped++;
      return;
    }

    const projection = await this.opts.projectionStore.get(subjectKey);
    if (!projection) {
      result.skipped++;
      return;
    }

    const at = this.now();
    if (this.shouldMarkIdleLong(projection, at)) {
      try {
        await this.opts.ballCustody.record(buildTaskIdleLongEvent({ taskId, at }));
        result.idleMarked++;
      } catch (err) {
        result.failed++;
        this.opts.logger?.warn?.({ err, taskId }, 'F233 PR4: idle-long event record failed');
      }
      return;
    }

    if (projection.state !== 'blocked') {
      result.skipped++;
      return;
    }

    await this.processBlockedTask({ taskId, projection, at, result });
  }

  private async processBlockedTask(input: {
    taskId: string;
    projection: BallCustodyProjection;
    at: number;
    result: BallCustodyProbeTickResult;
  }): Promise<void> {
    const { taskId, projection, at, result } = input;
    const task = await this.opts.taskStore.get(taskId);
    if (!task || task.status !== 'blocked' || !task.probe) {
      result.skipped++;
      return;
    }

    // The live task record is the source of truth for PATCH updates; projection is replay state.
    const resolveMode = task.resolveMode;
    if (resolveMode !== 'bounces_back' && resolveMode !== 'completes') {
      result.skipped++;
      return;
    }

    result.checked++;
    let probe: BallCustodyProbeResult;
    try {
      probe = await this.opts.probeEvaluator.evaluate({ task, projection });
    } catch (err) {
      result.failed++;
      this.opts.logger?.warn?.({ err, taskId }, 'F233 PR4: probe evaluation failed');
      return;
    }
    if (!probe.satisfied) return;

    if (resolveMode === 'completes') {
      await this.opts.taskStore.update(task.id, { status: 'done' });
      result.completed++;
      return;
    }

    const blockedSinceAt = projection.blockedSinceAt ?? projection.lastStateChangeAt;
    const lastWakeAt = this.effectiveLastWakeAt(task.id, blockedSinceAt, projection.lastWakeAt, at);
    if (lastWakeAt !== null && at - lastWakeAt < this.wakeCooldownMs) {
      result.cooldownSkipped++;
      return;
    }

    try {
      await this.opts.wakeSender.send({ task, projection, at });
      this.rememberDeliveredWake(task.id, blockedSinceAt, at);
      result.woken++;
    } catch (err) {
      result.failed++;
      this.opts.logger?.warn?.({ err, taskId }, 'F233 PR4: wake delivery failed');
      return;
    }

    try {
      await this.opts.ballCustody.record(
        buildWakeSentEvent({
          taskId: task.id,
          threadId: task.threadId,
          ownerCatId: task.ownerCatId,
          blockedSinceAt,
          at,
        }),
      );
    } catch (err) {
      result.failed++;
      this.opts.logger?.warn?.({ err, taskId }, 'F233 PR4: wake event record failed after delivery');
    }
  }

  private shouldMarkIdleLong(projection: BallCustodyProjection, at: number): boolean {
    if (!IDLE_LONG_STATES.has(projection.state)) return false;
    return at - projection.lastEventAt >= this.idleLongMs;
  }

  private wakeEpisodeKey(taskId: string, blockedSinceAt: number): string {
    return `${taskId}:${blockedSinceAt}`;
  }

  private effectiveLastWakeAt(
    taskId: string,
    blockedSinceAt: number,
    projectionLastWakeAt: number | null,
    at: number,
  ): number | null {
    const key = this.wakeEpisodeKey(taskId, blockedSinceAt);
    const deliveredWakeAt = this.deliveredWakeAtByEpisode.get(key);
    if (deliveredWakeAt != null && at - deliveredWakeAt >= this.wakeCooldownMs) {
      this.deliveredWakeAtByEpisode.delete(key);
    }
    const activeDeliveredWakeAt = this.deliveredWakeAtByEpisode.get(key) ?? null;
    if (projectionLastWakeAt == null) return activeDeliveredWakeAt;
    if (activeDeliveredWakeAt == null) return projectionLastWakeAt;
    return Math.max(projectionLastWakeAt, activeDeliveredWakeAt);
  }

  private rememberDeliveredWake(taskId: string, blockedSinceAt: number, at: number): void {
    this.deliveredWakeAtByEpisode.set(this.wakeEpisodeKey(taskId, blockedSinceAt), at);
  }
}
