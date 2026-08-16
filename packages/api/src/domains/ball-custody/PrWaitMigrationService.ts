import type { GitHubPrAwaitStateV1, GitHubPrWaitPredicate, PrAutomationState, TaskItem } from '@cat-cafe/shared';
import type { ITaskStore } from '../cats/services/stores/ports/TaskStore.js';
import type { InitialPrWaitSnapshot } from '../github-signals/GitHubWaitBaselineReader.js';

const LEGACY_KEYS = ['intent', 'wakePolicy', 'trackingInstructions', 'eventWait'] as const;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60_000;

type LegacyState = Record<string, unknown>;

export interface PrWaitMigrationReport {
  readonly migratedActive: number;
  readonly cleanedDone: number;
  readonly alreadyCurrent: number;
}

export interface PrWaitMigrationServiceOptions {
  readonly taskStore: ITaskStore;
  readonly readBaseline: (
    repoFullName: string,
    prNumber: number,
    when: readonly GitHubPrWaitPredicate[],
  ) => Promise<InitialPrWaitSnapshot>;
  readonly now?: () => number;
  readonly log: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
}

function ownLegacyKeys(state: LegacyState): readonly string[] {
  return LEGACY_KEYS.filter((key) => Object.hasOwn(state, key));
}

function cleanCollectorState(state: LegacyState): PrAutomationState {
  const review = typeof state.review === 'object' && state.review ? state.review : undefined;
  const ci = typeof state.ci === 'object' && state.ci ? state.ci : undefined;
  const conflict = typeof state.conflict === 'object' && state.conflict ? state.conflict : undefined;
  return {
    ...(review ? { review: review as NonNullable<PrAutomationState['review']> } : {}),
    ...(ci ? { ci: ci as NonNullable<PrAutomationState['ci']> } : {}),
    ...(conflict ? { conflict: conflict as NonNullable<PrAutomationState['conflict']> } : {}),
    ...(typeof state.closedAt === 'number' ? { closedAt: state.closedAt } : {}),
  };
}

function legacyEventWaitTrigger(state: LegacyState): number | undefined {
  if (typeof state.eventWait !== 'object' || state.eventWait === null) return undefined;
  const eventWait = state.eventWait as Record<string, unknown>;
  const coverage =
    typeof eventWait.coverage === 'object' && eventWait.coverage !== null
      ? (eventWait.coverage as Record<string, unknown>)
      : undefined;
  if (coverage?.status !== 'covered') return undefined;
  return typeof coverage.triggerCommentId === 'number' ? coverage.triggerCommentId : undefined;
}

function migrationPredicates(state: LegacyState): readonly GitHubPrWaitPredicate[] {
  const triggerCommentId = legacyEventWaitTrigger(state);
  if (triggerCommentId) return [{ kind: 'pr_review_result_available', triggerCommentId }];
  if (state.intent === 'merge') {
    return [{ kind: 'pr_head_changed' }, { kind: 'pr_ci_terminal' }, { kind: 'pr_became_conflicting' }];
  }
  // Legacy reviewer registrations never encoded a machine-verifiable review
  // predicate. Broad decision activity would preserve the old actor heuristic
  // under a typed name, so the safe migration default is a new HEAD only.
  return [{ kind: 'pr_head_changed' }];
}

function migrationNextStep(when: readonly GitHubPrWaitPredicate[]): string {
  if (when.some((predicate) => predicate.kind === 'pr_review_result_available')) {
    return 'Inspect the verified exact-HEAD review result.';
  }
  if (when.some((predicate) => predicate.kind === 'pr_ci_terminal')) {
    return 'Re-lock the exact HEAD and continue merge-gate.';
  }
  return 'Re-lock the exact HEAD and review the delta.';
}

function auditWhy(task: TaskItem, state: LegacyState): string {
  const instructions = typeof state.trackingInstructions === 'string' ? state.trackingInstructions.trim() : '';
  if (!instructions) return task.why;
  const bounded = instructions.slice(0, 240).replace(/[\r\n]+/g, ' ');
  return `${task.why}\n\nLegacy PR tracking note (audit only): ${bounded}`.slice(0, 2_000);
}

function parseSubject(task: TaskItem): { repoFullName: string; prNumber: number } | null {
  const match = task.subjectKey?.match(/^pr:(.+)#(\d+)$/);
  if (!match) return null;
  return { repoFullName: match[1], prNumber: Number(match[2]) };
}

export class PrWaitMigrationService {
  private readonly now: () => number;

  constructor(private readonly opts: PrWaitMigrationServiceOptions) {
    this.now = opts.now ?? Date.now;
  }

  async migrateAll(): Promise<PrWaitMigrationReport> {
    let migratedActive = 0;
    let cleanedDone = 0;
    let alreadyCurrent = 0;
    const tasks = await this.opts.taskStore.listByKind('pr_tracking');
    for (const candidate of tasks) {
      const result = await this.migrateOne(candidate.id);
      if (result === 'active') migratedActive += 1;
      else if (result === 'done') cleanedDone += 1;
      else alreadyCurrent += 1;
    }
    await this.assertNoLegacyPrState();
    const report = { migratedActive, cleanedDone, alreadyCurrent };
    this.opts.log.info(report, '[F280] PR wait schema migration complete');
    return report;
  }

  private async migrateOne(taskId: string): Promise<'active' | 'done' | 'current'> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const task = await this.opts.taskStore.get(taskId);
      if (!task || task.kind !== 'pr_tracking') return 'current';
      const raw = (task.automationState ?? {}) as LegacyState;
      if (ownLegacyKeys(raw).length === 0) return 'current';
      const collector = cleanCollectorState(raw);
      if (task.status === 'done') {
        const replaced = await this.opts.taskStore.replaceAutomationStateIfGeneration(task.id, {
          expectedGeneration: null,
          expectedUpdatedAt: task.updatedAt,
          automationState: collector,
          why: auditWhy(task, raw),
          status: 'done',
        });
        if (replaced) return 'done';
        continue;
      }

      const subject = parseSubject(task);
      if (!subject) throw new Error(`Invalid PR tracking subject key: ${task.subjectKey ?? task.id}`);
      const when = migrationPredicates(raw);
      const snapshot = await this.opts.readBaseline(subject.repoFullName, subject.prNumber, when);
      const now = this.now();
      const awaitState: GitHubPrAwaitStateV1 = {
        v: 1,
        generation: 1,
        subjectRef: `pr:${subject.repoFullName.toLowerCase()}#${subject.prNumber}`,
        ownerFence: { kind: 'containing_task', generation: 1 },
        baseline: snapshot.baseline,
        continuation: {
          when,
          // biome-ignore lint/suspicious/noThenProperty: frozen F280 contract field.
          then: migrationNextStep(when),
        },
        expiresAt: now + THIRTY_DAYS_MS,
        createdAt: now,
        provenance: 'legacy_migration_default',
      };
      const replacement: PrAutomationState = {
        ...collector,
        ...snapshot.collectorState,
        await: awaitState,
      };
      const replaced = await this.opts.taskStore.replaceAutomationStateIfGeneration(task.id, {
        expectedGeneration: null,
        expectedUpdatedAt: task.updatedAt,
        automationState: replacement,
        why: auditWhy(task, raw),
        status: task.status,
      });
      if (replaced) return 'active';
    }
    throw new Error(`PR wait migration CAS exhausted for task ${taskId}`);
  }

  private async assertNoLegacyPrState(): Promise<void> {
    const tasks = await this.opts.taskStore.listByKind('pr_tracking');
    const residual = tasks.flatMap((task) => {
      const keys = ownLegacyKeys((task.automationState ?? {}) as LegacyState);
      return keys.length > 0 ? [`${task.id}:${keys.join(',')}`] : [];
    });
    if (residual.length > 0) {
      throw new Error(`F280 boot invariant failed; legacy PR state remains: ${residual.join('; ')}`);
    }
  }
}
