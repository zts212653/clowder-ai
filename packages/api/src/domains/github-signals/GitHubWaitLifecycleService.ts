import type {
  AutomationState,
  IssueWaitAutomationState,
  PrAutomationState,
  TaskItem,
  WaitOutcomeV1,
  WaitTerminationActor,
  WaitTerminationEventV1,
} from '@cat-cafe/shared';
import { createWaitContinuationCarrier, parseWaitOwnerFence } from '@cat-cafe/shared';
import type {
  ConnectorDeliveryDeps,
  ConnectorDeliveryInput,
} from '../../infrastructure/email/deliver-connector-message.js';
import { deliverConnectorMessage } from '../../infrastructure/email/deliver-connector-message.js';
import type { IWaitLifecycleEventLog } from '../ball-custody/WaitLifecycleEventLog.js';
import {
  isAwaitExpired,
  markWaitOutcomeDelivered,
  markWaitOutcomeLegacyUnfenced,
  transitionWaitState,
  type WaitTransitionEvent,
} from '../ball-custody/wait-state-machine.js';
import { automationGeneration } from '../cats/services/stores/ports/TaskAutomationState.js';
import type { ITaskStore } from '../cats/services/stores/ports/TaskStore.js';
import { type GitHubWaitFacts, matchGitHubWaitPredicates } from './GitHubWaitPredicateCatalog.js';
import { planWaitRenewal } from './GitHubWaitRenewalBaseline.js';
import {
  type GitHubReviewLoopBrake,
  REVIEW_LOOP_BRAKE_NEXT_STEP,
  REVIEW_LOOP_HISTORY_WARN_NEXT_STEP,
  renderGitHubWaitOutcome,
} from './github-wait-renderer.js';

export interface GitHubCollectorPatch {
  readonly review?: NonNullable<PrAutomationState['review']>;
  readonly ci?: NonNullable<PrAutomationState['ci']>;
  readonly conflict?: NonNullable<PrAutomationState['conflict']>;
  readonly issue?: NonNullable<IssueWaitAutomationState['issue']>;
}

export interface GitHubWaitObservation {
  readonly taskId: string;
  readonly facts: GitHubWaitFacts;
  readonly collectorPatch?: GitHubCollectorPatch;
  readonly subjectState?: 'merged' | 'closed';
  readonly at?: number;
  /** Source-owned, typed metadata for the connector message created by this observation. */
  readonly deliveryExtra?: ConnectorDeliveryInput['extra'];
  /** Action-time review-history observation; projected only through the existing outcome nextStep. */
  readonly reviewLoopBrake?: GitHubReviewLoopBrake;
}

export interface GitHubWaitNotified {
  readonly kind: 'notified';
  readonly task: TaskItem;
  readonly outcome: WaitOutcomeV1;
  readonly messageId: string;
  readonly content: string;
}

export type GitHubWaitLifecycleResult =
  | { readonly kind: 'not_tracked' | 'state_only' | 'deduped'; readonly reason: string }
  | GitHubWaitNotified
  | {
      /**
       * Every write this observation needed lost a race, so nothing of it was recorded: not its
       * collector state, not its match. Its source must collect it again — a cursor moved past it loses it.
       */
      readonly kind: 'unrecorded';
      readonly reason: 'generation_changed_concurrently';
    };

/**
 * Best-effort owner wake for a message this service flushed from the delivery outbox.
 *
 * #1392 AC-1: a flushed outcome belongs to the generation that produced it, not to the observation
 * that happened to flush it. It is deliberately not part of `observe`'s result: a collector that saw
 * it there would read its own poll's meaning into it — reporting a stale body as this poll's merge,
 * or running a conflict auto-resolve for a wait that never asked about conflicts. Whoever flushes the
 * outbox owes the wake, and that is this service.
 */
export type GitHubWaitOutboxWake = (delivered: GitHubWaitNotified) => void | Promise<void>;

const MAX_WRITE_ATTEMPTS = 3;
const LOST_RACE = Symbol('lost_race');

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
  /** Owner wake for outcomes flushed from the outbox; see GitHubWaitOutboxWake. */
  readonly wakeOwner?: GitHubWaitOutboxWake;
}

function mergeCollectorState(
  taskKind: TaskItem['kind'],
  state: AutomationState | undefined,
  patch: GitHubCollectorPatch | undefined,
): AutomationState {
  if (taskKind === 'issue_tracking') {
    const issueState = state as IssueWaitAutomationState | undefined;
    return {
      ...(issueState?.issue || patch?.issue ? { issue: { ...issueState?.issue, ...patch?.issue } } : {}),
      ...(issueState?.closedAt !== undefined ? { closedAt: issueState.closedAt } : {}),
      ...(issueState?.await ? { await: issueState.await } : {}),
      ...(issueState?.waitOutcome ? { waitOutcome: issueState.waitOutcome } : {}),
    };
  }
  const prState = state as PrAutomationState | undefined;
  return {
    ...(prState?.review || patch?.review ? { review: { ...prState?.review, ...patch?.review } } : {}),
    ...(prState?.ci || patch?.ci ? { ci: { ...prState?.ci, ...patch?.ci } } : {}),
    ...(prState?.conflict || patch?.conflict ? { conflict: { ...prState?.conflict, ...patch?.conflict } } : {}),
    ...(prState?.closedAt !== undefined ? { closedAt: prState.closedAt } : {}),
    ...(prState?.await ? { await: prState.await } : {}),
    ...(prState?.waitOutcome ? { waitOutcome: prState.waitOutcome } : {}),
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
    waitKind: task.kind === 'issue_tracking' ? 'github_issue' : 'github_pr',
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

function isGitHubWaitTask(task: TaskItem | null | undefined): task is TaskItem {
  return task !== null && task !== undefined && (task.kind === 'pr_tracking' || task.kind === 'issue_tracking');
}

/** Which outcomes this call has already flushed from the outbox. */
interface OutboxLog {
  readonly ids: Set<string>;
}

export class GitHubWaitLifecycleService {
  private readonly now: () => number;

  constructor(private readonly opts: GitHubWaitLifecycleServiceOptions) {
    this.now = opts.now ?? Date.now;
  }

  async observe(input: GitHubWaitObservation): Promise<GitHubWaitLifecycleResult> {
    const outbox: OutboxLog = { ids: new Set() };
    let lostRaces = 0;
    while (lostRaces < MAX_WRITE_ATTEMPTS) {
      const task = await this.opts.taskStore.get(input.taskId);
      if (!isGitHubWaitTask(task)) return { kind: 'not_tracked', reason: `No GitHub wait task ${input.taskId}` };

      const drained = await this.drainOutbox(task, input, outbox);
      if (drained !== 'empty') {
        if (drained === 'raced') lostRaces += 1;
        continue;
      }

      const result = await this.evaluate(task, input);
      if (result === LOST_RACE) {
        lostRaces += 1;
        continue;
      }
      return result;
    }
    return { kind: 'unrecorded', reason: 'generation_changed_concurrently' };
  }

  /**
   * A pending outcome is the delivery outbox: deliver it before an observation may replace it.
   * #1392 AC-1: after a renewal, N pending beside a live N+1 is an ordinary state, and the observation
   * still belongs to N+1 — so delivering N never ends the call. Nor does it spend one of the
   * observation's write attempts: only an outcome that appeared while this call ran means a writer
   * raced it. What was flushed is this service's to wake for; the caller never hears about it.
   */
  private async drainOutbox(
    task: TaskItem,
    input: GitHubWaitObservation,
    outbox: OutboxLog,
  ): Promise<'empty' | 'drained' | 'raced'> {
    const pending = pendingOutcome(task);
    if (!pending || outbox.ids.has(pending.outcomeId)) return 'empty';
    const raced = outbox.ids.size > 0;
    outbox.ids.add(pending.outcomeId);
    await this.wakeForFlushedOutcome(await this.publishPending(task, pending, input.deliveryExtra));
    return raced ? 'raced' : 'drained';
  }

  private async wakeForFlushedOutcome(flushed: GitHubWaitLifecycleResult): Promise<void> {
    if (flushed.kind !== 'notified' || !this.opts.wakeOwner) return;
    try {
      await this.opts.wakeOwner(flushed);
    } catch (error) {
      this.opts.log.warn(
        { error, taskId: flushed.task.id, outcomeId: flushed.outcome.outcomeId },
        '[F280] outbox wake failed; the message is delivered',
      );
    }
  }

  /** One attempt to record an observation against the task as read; LOST_RACE if its write lost. */
  private async evaluate(
    task: TaskItem,
    input: GitHubWaitObservation,
  ): Promise<GitHubWaitLifecycleResult | typeof LOST_RACE> {
    const state = task.automationState;
    const active = state?.await;
    const collectorState = mergeCollectorState(task.kind, state, input.collectorPatch);
    if (!active) {
      if (input.subjectState) {
        const installed = await this.opts.taskStore.replaceAutomationStateIfGeneration(task.id, {
          expectedGeneration: null,
          expectedUpdatedAt: task.updatedAt,
          automationState: collectorState,
          status: 'done',
        });
        if (!installed) return LOST_RACE;
        return { kind: 'state_only', reason: 'subject_terminal_without_active_wait' };
      }
      if (input.collectorPatch) {
        await this.opts.taskStore.patchAutomationState(task.id, input.collectorPatch as Partial<AutomationState>);
      }
      return { kind: 'state_only', reason: 'no_active_wait' };
    }

    const at = input.at ?? this.now();
    const nextStepOverride =
      input.reviewLoopBrake?.kind === 'pause_once'
        ? REVIEW_LOOP_BRAKE_NEXT_STEP
        : input.reviewLoopBrake?.kind === 'warn_open'
          ? `${REVIEW_LOOP_HISTORY_WARN_NEXT_STEP}${active.continuation.then}`
          : null;
    const transitionState: AutomationState = nextStepOverride
      ? ({
          ...collectorState,
          await: {
            ...active,
            // biome-ignore lint/suspicious/noThenProperty: F280 continuation contract field.
            continuation: { ...active.continuation, then: nextStepOverride },
          },
        } as AutomationState)
      : collectorState;
    let transition: WaitTransitionEvent;
    if (input.subjectState) {
      // #1392 AC-2: terminal ends tracking, not the poll it arrived in. Whatever else this poll
      // matched is delivered with it — after this outcome the task is done and never polled again.
      transition = {
        type: 'subject_terminal',
        generation: active.generation,
        at,
        subjectState: input.subjectState,
        matched: matchGitHubWaitPredicates(active.continuation.when, active.baseline, input.facts),
      };
    } else {
      const matched = matchGitHubWaitPredicates(active.continuation.when, active.baseline, input.facts);
      if (matched.length === 0 && !isAwaitExpired(active, at)) {
        if (input.collectorPatch) {
          await this.opts.taskStore.patchAutomationState(task.id, input.collectorPatch as Partial<AutomationState>);
        }
        return { kind: 'state_only', reason: 'predicates_not_matched' };
      }
      transition = {
        type: 'predicates_matched',
        generation: active.generation,
        at,
        matched,
        ...(active.autoRenew === false
          ? {}
          : {
              renewal: planWaitRenewal(active, collectorState, input.facts, at, (error) =>
                this.opts.log.warn(
                  { error, taskId: task.id },
                  '[#1392] next generation not built; tracking not rearmed',
                ),
              ),
            }),
      };
    }

    const transitioned = transitionWaitState(transitionState, transition);
    if (!transitioned.applied) {
      return { kind: 'deduped', reason: transitioned.reason };
    }
    const replacement = transitioned.state as AutomationState;
    const installed = await this.opts.taskStore.replaceAutomationStateIfGeneration(task.id, {
      expectedGeneration: active.generation,
      expectedUpdatedAt: task.updatedAt,
      automationState: replacement,
      // #1392 AC-1: a renewed wait is still being tracked; only a wait that ended is done.
      status: replacement.await ? 'doing' : 'done',
    });
    if (!installed) return LOST_RACE;
    const outcome = installed.automationState?.waitOutcome;
    if (!outcome) return { kind: 'state_only', reason: 'terminalized_without_outcome' };
    await this.appendLifecycleEvent(installed, outcome);
    if (outcome.delivery !== 'pending') {
      return { kind: 'state_only', reason: outcome.reason };
    }
    return this.publishPending(installed, outcome, input.deliveryExtra);
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
    if (!isGitHubWaitTask(task)) return { kind: 'not_tracked', reason: 'task_missing' };
    const outcome = task.automationState?.waitOutcome;
    if (!outcome) return { kind: 'state_only', reason: 'nothing_to_recover' };
    await this.appendLifecycleEvent(task, outcome);
    if (outcome.delivery !== 'pending') return { kind: 'state_only', reason: outcome.reason };
    // The same outbox: a message the crash left undelivered has no other path to its owner.
    const flushed = await this.publishPending(task, outcome);
    await this.wakeForFlushedOutcome(flushed);
    return flushed;
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
      if (!isGitHubWaitTask(task)) return { kind: 'not_tracked', reason: 'task_missing' };
      const state = task.automationState;
      const active = state?.await;
      if (!active) return { kind: 'deduped', reason: 'no_active_wait' };
      const event = { ...template, generation: active.generation } as WaitTransitionEvent;
      const transitioned = transitionWaitState(state, event);
      if (!transitioned.applied) return { kind: 'deduped', reason: transitioned.reason };
      const installed = await this.opts.taskStore.replaceAutomationStateIfGeneration(task.id, {
        expectedGeneration: active.generation,
        expectedUpdatedAt: task.updatedAt,
        automationState: transitioned.state as AutomationState,
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
    if (!parseWaitOwnerFence(outcome.ownerFence)) {
      return this.quarantineLegacyUnfencedOutcome(task, outcome);
    }
    const content = renderGitHubWaitOutcome(outcome);
    const waitContinuationCarrier = createWaitContinuationCarrier(task.id, outcome);
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
        url: outcome.subjectRef.startsWith('pr:')
          ? `https://github.com/${outcome.subjectRef.slice('pr:'.length).replace('#', '/pull/')}`
          : `https://github.com/${outcome.subjectRef.slice('issue:'.length).replace('#', '/issues/')}`,
        meta: { waitContinuationCarrier },
      },
      ...(deliveryExtra ? { extra: deliveryExtra } : {}),
    });

    const current = await this.opts.taskStore.get(task.id);
    if (current?.automationState?.waitOutcome?.outcomeId === outcome.outcomeId) {
      const marked = markWaitOutcomeDelivered(current.automationState ?? {}, outcome.outcomeId);
      await this.opts.taskStore.replaceAutomationStateIfGeneration(task.id, {
        // After a renewal the store is already at N+1 while this outcome is N. Fencing on the
        // outcome's own generation would fail every time, leave it `pending`, and re-deliver it on
        // every poll. The fence is the store's current generation; the outcomeId check above is
        // what ties this write to this outcome.
        expectedGeneration: automationGeneration(current.automationState) ?? outcome.generation,
        expectedUpdatedAt: current.updatedAt,
        automationState: marked as AutomationState,
        status: current.automationState?.await ? 'doing' : 'done',
      });
    }
    this.opts.log.info(
      { taskId: task.id, outcomeId: outcome.outcomeId },
      '[F280] delivered compact GitHub wait outcome',
    );
    return { kind: 'notified', task, outcome, messageId: result.messageId, content };
  }

  private async quarantineLegacyUnfencedOutcome(
    task: TaskItem,
    outcome: WaitOutcomeV1,
  ): Promise<GitHubWaitLifecycleResult> {
    this.opts.log.warn(
      { taskId: task.id, outcomeId: outcome.outcomeId },
      `[F280] quarantined legacy unfenced wait outcome ${task.id}; no continuation was published`,
    );
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = attempt === 0 ? task : await this.opts.taskStore.get(task.id);
      const currentOutcome = current?.automationState?.waitOutcome;
      if (!current || currentOutcome?.outcomeId !== outcome.outcomeId) {
        return { kind: 'deduped', reason: 'outcome_changed_concurrently' };
      }
      if (currentOutcome.delivery !== 'pending') {
        return { kind: 'state_only', reason: currentOutcome.reason };
      }
      if (parseWaitOwnerFence(currentOutcome.ownerFence)) {
        return this.publishPending(current, currentOutcome);
      }
      const marked = markWaitOutcomeLegacyUnfenced(current.automationState as PrAutomationState, outcome.outcomeId);
      const installed = await this.opts.taskStore.replaceAutomationStateIfGeneration(task.id, {
        expectedGeneration: outcome.generation,
        expectedUpdatedAt: current.updatedAt,
        automationState: marked as PrAutomationState,
        status: 'done',
      });
      if (installed) return { kind: 'state_only', reason: 'legacy_unfenced' };
    }
    return { kind: 'deduped', reason: 'generation_changed_concurrently' };
  }
}
