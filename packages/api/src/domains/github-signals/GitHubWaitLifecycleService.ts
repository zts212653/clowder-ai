import type {
  PrAutomationState,
  TaskItem,
  WaitOutcomeV1,
  WaitTerminationActor,
  WaitTerminationEventV1,
} from '@cat-cafe/shared';
import type {
  ConnectorDeliveryDeps,
  ConnectorDeliveryInput,
} from '../../infrastructure/email/deliver-connector-message.js';
import { deliverConnectorMessage } from '../../infrastructure/email/deliver-connector-message.js';
import type { IWaitLifecycleEventLog } from '../ball-custody/WaitLifecycleEventLog.js';
import {
  markWaitOutcomeDelivered,
  transitionWaitState,
  type WaitTransitionEvent,
} from '../ball-custody/wait-state-machine.js';
import type { ITaskStore } from '../cats/services/stores/ports/TaskStore.js';
import { type GitHubWaitFacts, matchGitHubWaitPredicates } from './GitHubWaitPredicateCatalog.js';
import { renderGitHubWaitOutcome } from './github-wait-renderer.js';

export interface GitHubCollectorPatch {
  readonly review?: NonNullable<PrAutomationState['review']>;
  readonly ci?: NonNullable<PrAutomationState['ci']>;
  readonly conflict?: NonNullable<PrAutomationState['conflict']>;
}

export interface GitHubWaitObservation {
  readonly taskId: string;
  readonly facts: GitHubWaitFacts;
  readonly collectorPatch?: GitHubCollectorPatch;
  readonly subjectState?: 'merged' | 'closed';
  readonly at?: number;
  /** Source-owned, typed metadata for the connector message created by this observation. */
  readonly deliveryExtra?: ConnectorDeliveryInput['extra'];
}

export type GitHubWaitLifecycleResult =
  | { readonly kind: 'not_tracked' | 'state_only' | 'deduped'; readonly reason: string }
  | {
      readonly kind: 'notified';
      readonly task: TaskItem;
      readonly outcome: WaitOutcomeV1;
      readonly messageId: string;
      readonly content: string;
    };

export interface GitHubWaitLifecycleServiceOptions {
  readonly taskStore: ITaskStore;
  readonly deliveryDeps: ConnectorDeliveryDeps;
  readonly eventLog?: IWaitLifecycleEventLog;
  readonly log: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  readonly now?: () => number;
}

function mergeCollectorState(
  state: PrAutomationState | undefined,
  patch: GitHubCollectorPatch | undefined,
): PrAutomationState {
  return {
    ...(state?.review || patch?.review ? { review: { ...state?.review, ...patch?.review } } : {}),
    ...(state?.ci || patch?.ci ? { ci: { ...state?.ci, ...patch?.ci } } : {}),
    ...(state?.conflict || patch?.conflict ? { conflict: { ...state?.conflict, ...patch?.conflict } } : {}),
    ...(state?.closedAt !== undefined ? { closedAt: state.closedAt } : {}),
    ...(state?.await ? { await: state.await } : {}),
    ...(state?.waitOutcome ? { waitOutcome: state.waitOutcome } : {}),
  };
}

function lifecycleEvent(task: TaskItem, outcome: WaitOutcomeV1): WaitTerminationEventV1 {
  if (!task.userId || !task.ownerCatId) {
    throw new Error(`GitHub wait ${task.id} has no canonical owner identity`);
  }
  return {
    v: 1,
    eventId: outcome.outcomeId,
    kind: 'wait.terminated',
    waitId: task.id,
    waitKind: 'github_pr',
    subjectRef: outcome.subjectRef,
    threadId: task.threadId,
    ownerUserId: task.userId,
    ownerCatId: task.ownerCatId,
    generation: outcome.generation,
    reason: outcome.reason,
    actor: outcome.actor ?? { kind: 'system' },
    at: outcome.at,
  };
}

function pendingOutcome(task: TaskItem): WaitOutcomeV1 | null {
  const outcome = task.automationState?.waitOutcome;
  return outcome?.delivery === 'pending' ? outcome : null;
}

export class GitHubWaitLifecycleService {
  private readonly now: () => number;

  constructor(private readonly opts: GitHubWaitLifecycleServiceOptions) {
    this.now = opts.now ?? Date.now;
  }

  async observe(input: GitHubWaitObservation): Promise<GitHubWaitLifecycleResult> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const task = await this.opts.taskStore.get(input.taskId);
      if (!task || task.kind !== 'pr_tracking') {
        return { kind: 'not_tracked', reason: `No PR wait task ${input.taskId}` };
      }

      const existingPending = pendingOutcome(task);
      if (existingPending) return this.publishPending(task, existingPending, input.deliveryExtra);

      const state = task.automationState as PrAutomationState | undefined;
      const active = state?.await;
      const collectorState = mergeCollectorState(state, input.collectorPatch);
      if (!active) {
        if (input.collectorPatch) await this.opts.taskStore.patchAutomationState(task.id, input.collectorPatch);
        return { kind: 'state_only', reason: 'no_active_wait' };
      }

      const at = input.at ?? this.now();
      let transition: WaitTransitionEvent;
      if (input.subjectState) {
        transition = {
          type: 'subject_terminal',
          generation: active.generation,
          at,
          subjectState: input.subjectState,
        };
      } else {
        const matched = matchGitHubWaitPredicates(active.continuation.when, active.baseline, input.facts);
        if (matched.length === 0 && at < active.expiresAt) {
          if (input.collectorPatch) await this.opts.taskStore.patchAutomationState(task.id, input.collectorPatch);
          return { kind: 'state_only', reason: 'predicates_not_matched' };
        }
        transition = {
          type: 'predicates_matched',
          generation: active.generation,
          at,
          matched,
        };
      }

      const transitioned = transitionWaitState(collectorState, transition);
      if (!transitioned.applied) {
        return { kind: 'deduped', reason: transitioned.reason };
      }
      const replacement = transitioned.state as PrAutomationState;
      const installed = await this.opts.taskStore.replaceAutomationStateIfGeneration(task.id, {
        expectedGeneration: active.generation,
        expectedUpdatedAt: task.updatedAt,
        automationState: replacement,
        status: 'done',
      });
      if (!installed) continue;
      const outcome = installed.automationState?.waitOutcome;
      if (!outcome) return { kind: 'state_only', reason: 'terminalized_without_outcome' };
      await this.appendLifecycleEvent(installed, outcome);
      if (outcome.delivery !== 'pending') {
        return { kind: 'state_only', reason: outcome.reason };
      }
      return this.publishPending(installed, outcome, input.deliveryExtra);
    }
    return { kind: 'deduped', reason: 'generation_changed_concurrently' };
  }

  async cancel(
    taskId: string,
    actor: Extract<WaitTerminationActor, { kind: 'user' | 'cat' }>,
    at = this.now(),
  ): Promise<GitHubWaitLifecycleResult> {
    return this.terminalizeWithoutFacts(taskId, {
      type: 'user_cancel',
      generation: 0,
      at,
      actor,
    });
  }

  async ownerChanged(taskId: string, at = this.now()): Promise<GitHubWaitLifecycleResult> {
    return this.terminalizeWithoutFacts(taskId, {
      type: 'owner_changed',
      generation: 0,
      at,
    });
  }

  async recoverOutcome(taskId: string): Promise<GitHubWaitLifecycleResult> {
    const task = await this.opts.taskStore.get(taskId);
    if (!task || task.kind !== 'pr_tracking') return { kind: 'not_tracked', reason: 'task_missing' };
    const outcome = task.automationState?.waitOutcome;
    if (!outcome) return { kind: 'state_only', reason: 'nothing_to_recover' };
    await this.appendLifecycleEvent(task, outcome);
    if (outcome.delivery === 'pending') return this.publishPending(task, outcome);
    return { kind: 'state_only', reason: outcome.reason };
  }

  async recordOutcomeEvent(task: TaskItem, outcome: WaitOutcomeV1): Promise<void> {
    await this.appendLifecycleEvent(task, outcome);
  }

  private async terminalizeWithoutFacts(
    taskId: string,
    template: WaitTransitionEvent,
  ): Promise<GitHubWaitLifecycleResult> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const task = await this.opts.taskStore.get(taskId);
      if (!task || task.kind !== 'pr_tracking') return { kind: 'not_tracked', reason: 'task_missing' };
      const state = task.automationState as PrAutomationState | undefined;
      const active = state?.await;
      if (!active) return { kind: 'deduped', reason: 'no_active_wait' };
      const event = { ...template, generation: active.generation } as WaitTransitionEvent;
      const transitioned = transitionWaitState(state, event);
      if (!transitioned.applied) return { kind: 'deduped', reason: transitioned.reason };
      const installed = await this.opts.taskStore.replaceAutomationStateIfGeneration(task.id, {
        expectedGeneration: active.generation,
        expectedUpdatedAt: task.updatedAt,
        automationState: transitioned.state as PrAutomationState,
        status: 'done',
      });
      if (!installed) continue;
      const outcome = installed.automationState?.waitOutcome;
      if (!outcome) return { kind: 'state_only', reason: 'terminalized_without_outcome' };
      await this.appendLifecycleEvent(installed, outcome);
      return { kind: 'state_only', reason: outcome.reason };
    }
    return { kind: 'deduped', reason: 'generation_changed_concurrently' };
  }

  private async appendLifecycleEvent(task: TaskItem, outcome: WaitOutcomeV1): Promise<void> {
    if (!this.opts.eventLog) return;
    try {
      await this.opts.eventLog.append(lifecycleEvent(task, outcome));
    } catch (error) {
      this.opts.log.warn({ error, taskId: task.id, outcomeId: outcome.outcomeId }, '[F280] wait event append deferred');
    }
  }

  private async publishPending(
    task: TaskItem,
    outcome: WaitOutcomeV1,
    deliveryExtra?: ConnectorDeliveryInput['extra'],
  ): Promise<GitHubWaitLifecycleResult> {
    const content = renderGitHubWaitOutcome(outcome);
    const result = await deliverConnectorMessage(this.opts.deliveryDeps, {
      threadId: task.threadId,
      userId: task.userId ?? '',
      catId: task.ownerCatId ?? '',
      content,
      idempotencyKey: outcome.outcomeId,
      source: {
        connector: 'github-wait',
        label: 'GitHub Wait',
        icon: 'github',
        url: `https://github.com/${outcome.subjectRef.slice('pr:'.length).replace('#', '/pull/')}`,
      },
      ...(deliveryExtra ? { extra: deliveryExtra } : {}),
    });

    const current = await this.opts.taskStore.get(task.id);
    if (current?.automationState?.waitOutcome?.outcomeId === outcome.outcomeId) {
      const marked = markWaitOutcomeDelivered(current.automationState as PrAutomationState, outcome.outcomeId);
      await this.opts.taskStore.replaceAutomationStateIfGeneration(task.id, {
        expectedGeneration: outcome.generation,
        expectedUpdatedAt: current.updatedAt,
        automationState: marked as PrAutomationState,
        status: 'done',
      });
    }
    this.opts.log.info({ taskId: task.id, outcomeId: outcome.outcomeId }, '[F280] delivered compact PR wait outcome');
    return { kind: 'notified', task, outcome, messageId: result.messageId, content };
  }
}
