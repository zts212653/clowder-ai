import type { ITaskStore } from '../cats/services/stores/ports/TaskStore.js';
import type { GitHubWaitLifecycleService } from '../github-signals/GitHubWaitLifecycleService.js';

export class WaitLifecycleRecoverySweep {
  constructor(
    private readonly taskStore: ITaskStore,
    private readonly lifecycle: GitHubWaitLifecycleService,
  ) {}

  async run(): Promise<{ recovered: number }> {
    let recovered = 0;
    for (const task of await this.taskStore.listByKind('pr_tracking')) {
      if (!task.automationState?.waitOutcome) continue;
      await this.lifecycle.recoverOutcome(task.id);
      recovered += 1;
    }
    return { recovered };
  }
}
