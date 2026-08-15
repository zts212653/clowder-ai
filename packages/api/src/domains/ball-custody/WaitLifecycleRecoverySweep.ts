import type { ITaskStore } from '../cats/services/stores/ports/TaskStore.js';
import type { GitHubWaitLifecycleService } from '../github-signals/GitHubWaitLifecycleService.js';

export class WaitLifecycleRecoverySweep {
  constructor(
    private readonly taskStore: ITaskStore,
    private readonly lifecycle: GitHubWaitLifecycleService,
    private readonly log?: { warn: (...args: unknown[]) => void },
  ) {}

  async run(): Promise<{ recovered: number }> {
    let recovered = 0;
    const tasks = [
      ...(await this.taskStore.listByKind('pr_tracking')),
      ...(await this.taskStore.listByKind('issue_tracking')),
    ];
    for (const task of tasks) {
      if (!task.automationState?.waitOutcome) continue;
      try {
        await this.lifecycle.recoverOutcome(task.id);
        recovered += 1;
      } catch (error) {
        this.log?.warn(
          { error, taskId: task.id },
          '[F280] isolated wait outcome recovery failure; continuing startup sweep',
        );
      }
    }
    return { recovered };
  }
}
