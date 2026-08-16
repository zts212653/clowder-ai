import type {
  GitHubIssueAwaitStateV1,
  GitHubIssueWaitPredicate,
  IssueWaitAutomationState,
  TaskItem,
} from '@cat-cafe/shared';
import type { ITaskStore } from '../cats/services/stores/ports/TaskStore.js';
import type { InitialIssueWaitSnapshot } from '../github-signals/GitHubIssueWaitBaselineReader.js';

const LEGACY_KEYS = ['wakePolicy', 'trackingInstructions'] as const;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60_000;
type LegacyState = Record<string, unknown>;

export interface IssueWaitMigrationReport {
  readonly migratedActive: number;
  readonly cleanedDone: number;
  readonly alreadyCurrent: number;
}

export interface IssueWaitMigrationServiceOptions {
  readonly taskStore: ITaskStore;
  readonly readBaseline: (repoFullName: string, issueNumber: number) => Promise<InitialIssueWaitSnapshot>;
  readonly now?: () => number;
  readonly log: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
}

function ownLegacyKeys(state: LegacyState): readonly string[] {
  return LEGACY_KEYS.filter((key) => Object.hasOwn(state, key));
}

function cleanCollectorState(state: LegacyState): IssueWaitAutomationState {
  const issue = typeof state.issue === 'object' && state.issue ? state.issue : undefined;
  return {
    ...(issue ? { issue: issue as NonNullable<IssueWaitAutomationState['issue']> } : {}),
    ...(typeof state.closedAt === 'number' ? { closedAt: state.closedAt } : {}),
  };
}

function parseSubject(task: TaskItem): { repoFullName: string; issueNumber: number } | null {
  const match = task.subjectKey?.match(/^issue:(.+)#(\d+)$/);
  return match ? { repoFullName: match[1], issueNumber: Number(match[2]) } : null;
}

function auditWhy(task: TaskItem, state: LegacyState): string {
  const instructions = typeof state.trackingInstructions === 'string' ? state.trackingInstructions.trim() : '';
  if (!instructions) return task.why;
  return `${task.why}\n\nLegacy issue tracking note (audit only): ${instructions.slice(0, 240).replace(/[\r\n]+/g, ' ')}`.slice(
    0,
    2_000,
  );
}

function migrationPredicates(): readonly GitHubIssueWaitPredicate[] {
  // Legacy actor policy cannot be translated without preserving the same identity
  // heuristic F280 removes. Freeze the live frontier, then use the catalog's explicit
  // generic-comment default; future generations must be registered explicitly.
  return [{ kind: 'issue_comment_added' }];
}

export class IssueWaitMigrationService {
  private readonly now: () => number;

  constructor(private readonly opts: IssueWaitMigrationServiceOptions) {
    this.now = opts.now ?? Date.now;
  }

  async migrateAll(): Promise<IssueWaitMigrationReport> {
    let migratedActive = 0;
    let cleanedDone = 0;
    let alreadyCurrent = 0;
    for (const task of await this.opts.taskStore.listByKind('issue_tracking')) {
      const result = await this.migrateOne(task.id);
      if (result === 'active') migratedActive += 1;
      else if (result === 'done') cleanedDone += 1;
      else alreadyCurrent += 1;
    }
    await this.assertNoLegacyIssueState();
    const report = { migratedActive, cleanedDone, alreadyCurrent };
    this.opts.log.info(report, '[F280] issue wait schema migration complete');
    return report;
  }

  private async migrateOne(taskId: string): Promise<'active' | 'done' | 'current'> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const task = await this.opts.taskStore.get(taskId);
      if (!task || task.kind !== 'issue_tracking') return 'current';
      const raw = (task.automationState ?? {}) as LegacyState;
      if (ownLegacyKeys(raw).length === 0) return 'current';
      const migrated = await this.migrateSnapshot(task, raw);
      if (migrated) return migrated;
    }
    throw new Error(`Issue wait migration CAS exhausted for task ${taskId}`);
  }

  private async migrateSnapshot(task: TaskItem, raw: LegacyState): Promise<'active' | 'done' | null> {
    if (task.status === 'done') return (await this.cleanCompleted(task, raw)) ? 'done' : null;

    const subject = parseSubject(task);
    if (!subject) throw new Error(`Invalid issue tracking subject key: ${task.subjectKey ?? task.id}`);
    const snapshot = await this.opts.readBaseline(subject.repoFullName, subject.issueNumber);
    const now = this.now();
    const awaitState: GitHubIssueAwaitStateV1 = {
      v: 1,
      generation: 1,
      subjectRef: `issue:${subject.repoFullName.toLowerCase()}#${subject.issueNumber}`,
      ownerFence: { kind: 'containing_task', generation: 1 },
      baseline: snapshot.baseline,
      continuation: {
        when: migrationPredicates(),
        // biome-ignore lint/suspicious/noThenProperty: frozen F280 contract field.
        then: 'Inspect the matched issue activity and continue the owning task.',
      },
      expiresAt: now + THIRTY_DAYS_MS,
      createdAt: now,
      provenance: 'legacy_migration_default',
    };
    const replacement: IssueWaitAutomationState = { ...snapshot.collectorState, await: awaitState };
    const replaced = await this.opts.taskStore.replaceAutomationStateIfGeneration(task.id, {
      expectedGeneration: null,
      expectedUpdatedAt: task.updatedAt,
      automationState: replacement,
      why: auditWhy(task, raw),
      status: task.status,
    });
    return replaced ? 'active' : null;
  }

  private async cleanCompleted(task: TaskItem, raw: LegacyState): Promise<boolean> {
    const replaced = await this.opts.taskStore.replaceAutomationStateIfGeneration(task.id, {
      expectedGeneration: null,
      expectedUpdatedAt: task.updatedAt,
      automationState: cleanCollectorState(raw),
      why: auditWhy(task, raw),
      status: 'done',
    });
    return replaced !== null;
  }

  private async assertNoLegacyIssueState(): Promise<void> {
    const residual = (await this.opts.taskStore.listByKind('issue_tracking')).flatMap((task) => {
      const keys = ownLegacyKeys((task.automationState ?? {}) as LegacyState);
      return keys.length > 0 ? [`${task.id}:${keys.join(',')}`] : [];
    });
    if (residual.length > 0) {
      throw new Error(`F280 boot invariant failed; legacy issue state remains: ${residual.join('; ')}`);
    }
  }
}
