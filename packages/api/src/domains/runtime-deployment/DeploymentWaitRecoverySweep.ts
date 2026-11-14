import { performance } from 'node:perf_hooks';
import type { TaskItem } from '@cat-cafe/shared';
import { recoveryGuarded } from '../../infrastructure/recovery/recovery-deadline.js';
import { runDueBatch } from '../../infrastructure/recovery/run-due-batch.js';
import type { DeploymentObservationProvider } from '../../routes/callback-deployment-wait-routes.js';
import type { ITaskStore } from '../cats/services/stores/ports/TaskStore.js';
import type { DeploymentWaitLifecycleService } from './DeploymentWaitLifecycleService.js';

export class DeploymentWaitRecoverySweep {
  private cadenceMs = 60_000;
  private periodicTimer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<{ checked: number; recovered: number }> | null = null;

  constructor(
    private readonly taskStore: ITaskStore,
    private readonly observationProvider: DeploymentObservationProvider,
    private readonly lifecycle: Pick<DeploymentWaitLifecycleService, 'observe' | 'recoverOutcome' | 'recoverAudit'>,
    private readonly log?: { warn: (...args: unknown[]) => void; info?: (...args: unknown[]) => void },
    private readonly now: () => number = Date.now,
  ) {
    this.taskStore = recoveryGuarded(taskStore);
    this.observationProvider = recoveryGuarded(observationProvider);
    this.lifecycle = recoveryGuarded(lifecycle);
  }

  startPeriodic(intervalMs = 60_000): void {
    if (this.periodicTimer) return;
    this.cadenceMs = intervalMs;
    this.periodicTimer = setInterval(() => {
      void this.run().catch((error) =>
        this.log?.warn({ err: error }, '[F323] deployment wait compensation sweep failed'),
      );
    }, intervalMs);
    this.periodicTimer.unref?.();
  }

  stopPeriodic(): void {
    if (!this.periodicTimer) return;
    clearInterval(this.periodicTimer);
    this.periodicTimer = null;
  }

  async run(): Promise<{ checked: number; recovered: number }> {
    if (this.inFlight) return this.inFlight;
    const pending = this.runOnce();
    this.inFlight = pending;
    try {
      return await pending;
    } finally {
      if (this.inFlight === pending) this.inFlight = null;
    }
  }

  private async runOnce(): Promise<{ checked: number; recovered: number }> {
    const started = performance.now();
    let checked = 0;
    let recovered = 0;
    const now = this.now();
    const live = await runDueBatch({
      limit: 100,
      budgetMs: 5_000,
      selectDue: (limit) => this.taskStore.listDueDeploymentWaitRecovery(limit, now),
      process: async (task) => {
        const outcome = await this.inspect(task);
        checked += outcome.checked;
        recovered += outcome.recovered;
        await this.taskStore.finishDeploymentWaitRecovery(task, now + this.cadenceMs, false);
      },
      onItemError: async (task, error) => {
        await this.taskStore.finishDeploymentWaitRecovery(task, now + this.cadenceMs, true);
        this.log?.warn({ err: error, taskId: task.id }, '[F323] isolated deployment wait recovery failure');
      },
    });
    const audit = await runDueBatch({
      limit: 100,
      budgetMs: 5_000,
      selectDue: (limit) => this.taskStore.listDeploymentWaitAuditCandidates(limit, now),
      process: async (entry) => {
        if (!(await this.lifecycle.recoverAudit(entry))) throw new Error('deployment_audit_confirmation_unavailable');
      },
      onItemError: async (entry, error) => {
        await this.taskStore.failDeploymentWaitAudit(entry, now);
        this.log?.warn(
          { err: error, taskId: entry.taskId, eventId: entry.event.eventId },
          '[F323] deployment wait audit deferred',
        );
      },
    });

    this.log?.info?.(
      {
        loopId: 'deployment-wait',
        elapsedMs: performance.now() - started,
        checked,
        recovered,
        liveSelected: live.selected,
        auditSelected: audit.selected,
        failed: live.failed + audit.failed,
        deferred: live.deferred + audit.deferred,
      },
      '[F323] deployment wait recovery summary',
    );
    return { checked, recovered };
  }

  private async inspect(task: TaskItem): Promise<{ checked: number; recovered: number }> {
    if (task.deploymentWait?.currentExecutionClaim || task.deploymentWait?.waitOutcome?.delivery === 'pending') {
      const result = await this.lifecycle.recoverOutcome(task.id);
      return { checked: 0, recovered: result.kind === 'notified' ? 1 : 0 };
    }
    const active = task.deploymentWait?.await;
    const predicate = active?.continuation.when[0];
    const deploymentId = active?.subjectRef.split(':')[2];
    if (!active || !predicate || !deploymentId) return { checked: 0, recovered: 0 };
    const observation = await this.observationProvider.observe({
      deploymentId,
      ...(predicate.kind === 'revision_included' ? { targetRevision: predicate.revision } : {}),
    });
    if (!observation) return { checked: 0, recovered: 0 };
    const result = await this.lifecycle.observe({ taskId: task.id, observation });
    return { checked: 1, recovered: result.kind === 'notified' ? 1 : 0 };
  }
}
