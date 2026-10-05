import type { TaskItem } from '@cat-cafe/shared';
import type { DeploymentObservationProvider } from '../../routes/callback-deployment-wait-routes.js';
import type { ITaskStore } from '../cats/services/stores/ports/TaskStore.js';
import type { DeploymentWaitLifecycleService } from './DeploymentWaitLifecycleService.js';

export class DeploymentWaitRecoverySweep {
  private periodicTimer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<{ checked: number; recovered: number }> | null = null;

  constructor(
    private readonly taskStore: ITaskStore,
    private readonly observationProvider: DeploymentObservationProvider,
    private readonly lifecycle: Pick<DeploymentWaitLifecycleService, 'observe' | 'recoverOutcome'>,
    private readonly log?: { warn: (...args: unknown[]) => void },
  ) {}

  startPeriodic(intervalMs = 60_000): void {
    if (this.periodicTimer) return;
    this.periodicTimer = setInterval(() => {
      void this.run().catch((error) => this.log?.warn({ error }, '[F323] deployment wait compensation sweep failed'));
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
    let checked = 0;
    let recovered = 0;
    for (const task of await this.taskStore.listByKind('work')) {
      try {
        const outcome = await this.inspect(task);
        checked += outcome.checked;
        recovered += outcome.recovered;
      } catch (error) {
        this.log?.warn({ error, taskId: task.id }, '[F323] isolated deployment wait recovery failure');
      }
    }
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
