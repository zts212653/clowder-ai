import type { TaskItem, TaskRecoveryIncident } from '@cat-cafe/shared';
import type { IBallCustodyProjectionStore } from './BallCustodyProjectionStore.js';
import type { TaskActionSuccessorLifecycle } from './TaskActionSuccessorLifecycle.js';

export class TaskRecoveryReadModel {
  constructor(
    private readonly sources: {
      action?: Pick<TaskActionSuccessorLifecycle, 'readRecoveryIncidents'>;
      ball?: Pick<IBallCustodyProjectionStore, 'getRecoveryFacts'>;
    },
  ) {}

  async project(task: TaskItem): Promise<TaskItem> {
    const incidents: TaskRecoveryIncident[] = [];
    if (this.sources.action) {
      try {
        incidents.push(...(await this.sources.action.readRecoveryIncidents(task)));
      } catch {
        incidents.push({
          source: 'action_successor',
          lane: 'task',
          disposition: 'needs_attention',
          reasonCode: 'action_recovery_read_failed',
          executionRef: `task:${task.id}:action-recovery`,
        });
      }
    }
    let facts: Awaited<ReturnType<IBallCustodyProjectionStore['getRecoveryFacts']>> | null | undefined;
    try {
      facts = await this.sources.ball?.getRecoveryFacts(`ball:task:${task.id}`);
    } catch {
      incidents.push({
        source: 'ball_probe',
        lane: 'probe',
        disposition: 'needs_attention',
        reasonCode: 'ball_recovery_read_failed',
        executionRef: `ball:task:${task.id}`,
      });
    }
    if (facts) {
      for (const lane of ['probe', 'idle'] as const) {
        const fact = facts[lane];
        if (fact?.disposition !== 'needs_attention' || !fact.reasonCode) continue;
        incidents.push({
          source: 'ball_probe',
          lane,
          disposition: 'needs_attention',
          reasonCode: fact.reasonCode,
          executionRef: `${facts.subjectKey}:${fact.scope}`,
        });
      }
    }
    return incidents.length ? { ...task, recovery: { v: 1, ownerRef: `task:${task.id}`, incidents } } : task;
  }

  projectMany(tasks: readonly TaskItem[]): Promise<TaskItem[]> {
    return Promise.all(tasks.map((task) => this.project(task)));
  }
}
