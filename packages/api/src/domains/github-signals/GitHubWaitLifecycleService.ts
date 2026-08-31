import type {
  AutomationState,
  AwaitStateV1,
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
  markWaitOutcomeDelivered,
  markWaitOutcomeLegacyUnfenced,
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

/**
 * Only auto-renew when explicitly opted in. Pre-existing waits without the
 * field were registered under one-shot semantics and must not be silently
 * converted to continuous tracking on deploy.
 */
function shouldAutoRenew(active: AwaitStateV1): boolean {
  return active.autoRenew === true;
}

/**
 * Compute the conversation comment cursor for a renewal baseline.
 * Priority: explicit resultConversationCommentCursor from facts → max ID
 * from conversationComments array → previous baseline value.
 */
function computeConversationCursor(
  explicitCursor: number | undefined,
  comments: readonly { readonly id: number }[] | undefined,
  fallback: number,
): number {
  if (explicitCursor !== undefined) return explicitCursor;
  if (comments && comments.length > 0) {
    return Math.max(...comments.map((c) => c.id));
  }
  return fallback;
}

export class GitHubWaitLifecycleService {
  private readonly now: () => number;

  constructor(private readonly opts: GitHubWaitLifecycleServiceOptions) {
    this.now = opts.now ?? Date.now;
  }

  async observe(input: GitHubWaitObservation): Promise<GitHubWaitLifecycleResult> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const task = await this.opts.taskStore.get(input.taskId);
      if (!task || (task.kind !== 'pr_tracking' && task.kind !== 'issue_tracking')) {
        return { kind: 'not_tracked', reason: `No GitHub wait task ${input.taskId}` };
      }

      const existingPending = pendingOutcome(task);
      if (existingPending) {
        // Merge collector state even when re-delivering a pending outcome,
        // so source facts from the current observation are not permanently lost.
        if (input.collectorPatch) {
          await this.opts.taskStore.patchAutomationState(task.id, input.collectorPatch as Partial<AutomationState>);
        }
        const deliveryResult = await this.publishPending(task, existingPending, input.deliveryExtra);

        // After delivering gen N, evaluate current facts against gen N+1 await
        // to prevent ephemeral fact loss. Without this, the collector cursor
        // advances past facts that gen N+1 never evaluates, permanently losing
        // matching events (e.g. a maintainer comment that arrives while gen N
        // delivery is still pending).
        const activeAwait = task.automationState?.await;
        if (activeAwait && input.facts && deliveryResult.kind === 'notified') {
          await this.advanceNextGeneration(input, activeAwait);
        }

        return deliveryResult;
      }

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
          if (!installed) continue;
          return { kind: 'state_only', reason: 'subject_terminal_without_active_wait' };
        }
        if (input.collectorPatch) {
          await this.opts.taskStore.patchAutomationState(task.id, input.collectorPatch as Partial<AutomationState>);
        }
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
        if (matched.length === 0) {
          if (active.expiresAt !== undefined && at >= active.expiresAt) {
            transition = { type: 'expired', generation: active.generation, at };
          } else {
            if (input.collectorPatch) {
              await this.opts.taskStore.patchAutomationState(task.id, input.collectorPatch as Partial<AutomationState>);
            }
            return { kind: 'state_only', reason: 'predicates_not_matched' };
          }
        } else {
          transition = {
            type: 'predicates_matched',
            generation: active.generation,
            at,
            matched,
          };
        }
      }

      const transitioned = transitionWaitState(collectorState, transition);
      if (!transitioned.applied) {
        return { kind: 'deduped', reason: transitioned.reason };
      }
      const replacement = transitioned.state as AutomationState;
      const outcome = replacement.waitOutcome;
      if (!outcome) return { kind: 'state_only', reason: 'terminalized_without_outcome' };

      // Determine if this delivery should atomically install the next generation.
      // Only renew on predicate match (never on expiry, terminal, cancel).
      const renewing =
        outcome.delivery === 'pending' &&
        outcome.reason === 'matched' &&
        shouldAutoRenew(active) &&
        !outcome.terminalSubjectState;

      let installState: AutomationState;
      let installStatus: 'done' | 'doing';
      if (renewing) {
        // Atomic renewal: single CAS writes both the delivered outcome AND
        // gen N+1 with fresh baseline — no gap where collectors see no active wait.
        const newGeneration = active.generation + 1;
        const baseline = this.buildRenewalBaseline(active, input.facts, collectorState);
        const awaitState = {
          v: 1 as const,
          generation: newGeneration,
          subjectRef: active.subjectRef,
          ownerFence: { kind: 'containing_task' as const, generation: newGeneration },
          baseline,
          continuation: {
            when: active.continuation.when,
            // biome-ignore lint/suspicious/noThenProperty: F280's frozen wait contract names this field `then`.
            then: active.continuation.then,
          },
          createdAt: this.now(),
          autoRenew: true,
          ...(active.expiresAt !== undefined ? { expiresAt: active.expiresAt } : {}),
          provenance: 'explicit_registration' as const,
        } as AwaitStateV1;
        installState = {
          ...replacement,
          await: awaitState,
          waitOutcome: { ...outcome, autoRenewed: true },
        } as AutomationState;
        installStatus = 'doing';
      } else {
        installState = replacement;
        installStatus = 'done';
      }

      const installed = await this.opts.taskStore.replaceAutomationStateIfGeneration(task.id, {
        expectedGeneration: active.generation,
        expectedUpdatedAt: task.updatedAt,
        automationState: installState,
        status: installStatus,
      });
      if (!installed) continue;
      await this.appendLifecycleEvent(installed, outcome);
      if (outcome.delivery !== 'pending') {
        return { kind: 'state_only', reason: outcome.reason };
      }
      if (renewing) {
        this.opts.log.info(
          { taskId: task.id, newGeneration: active.generation + 1 },
          '[F280] auto-renewed wait tracking with fresh baseline',
        );
      }
      // Use the installed state's outcome — it carries autoRenewed: true on renewal
      const deliveredOutcome = installState.waitOutcome ?? outcome;
      return this.publishPending(installed, deliveredOutcome, input.deliveryExtra);
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
    if (!task || (task.kind !== 'pr_tracking' && task.kind !== 'issue_tracking')) {
      return { kind: 'not_tracked', reason: 'task_missing' };
    }
    const outcome = task.automationState?.waitOutcome;
    if (!outcome) return { kind: 'state_only', reason: 'nothing_to_recover' };
    await this.appendLifecycleEvent(task, outcome);
    if (outcome.delivery === 'pending') return this.publishPending(task, outcome);
    return { kind: 'state_only', reason: outcome.reason };
  }

  async recordOutcomeEvent(task: TaskItem, outcome: WaitOutcomeV1): Promise<void> {
    await this.appendLifecycleEvent(task, outcome);
  }

  /**
   * After delivering gen N, evaluate current facts against the next-gen await.
   * If the facts match gen N+1's predicates, transition it (creating a new
   * pending outcome). If they don't match, advance the baseline to include
   * current facts so the next observation starts from the correct frontier.
   *
   * This is a best-effort side-effect — if the CAS fails, the facts will be
   * re-evaluated on the next observation cycle (the collector cursor advance
   * ensures they'll be re-fetched or the baseline advance ensures no gap).
   */
  private async advanceNextGeneration(input: GitHubWaitObservation, previousActiveAwait: AwaitStateV1): Promise<void> {
    const freshTask = await this.opts.taskStore.get(input.taskId);
    if (!freshTask) return;
    const currentAwait = freshTask.automationState?.await;
    if (!currentAwait || currentAwait.generation !== previousActiveAwait.generation) return;

    const collectorState = mergeCollectorState(
      freshTask.kind as 'pr_tracking' | 'issue_tracking',
      freshTask.automationState,
      undefined,
    );
    const matched = matchGitHubWaitPredicates(currentAwait.continuation.when, currentAwait.baseline, input.facts);

    if (matched.length > 0) {
      const at = input.at ?? this.now();
      const transition: WaitTransitionEvent = {
        type: 'predicates_matched',
        generation: currentAwait.generation,
        at,
        matched,
      };
      const transitioned = transitionWaitState(collectorState, transition);
      if (!transitioned.applied) return;
      const replacement = transitioned.state as AutomationState;
      const outcome = replacement.waitOutcome;
      if (!outcome) return;

      // Handle auto-renewal of gen N+1 → gen N+2
      const renewing =
        outcome.delivery === 'pending' &&
        outcome.reason === 'matched' &&
        shouldAutoRenew(currentAwait) &&
        !outcome.terminalSubjectState;

      let installState: AutomationState;
      let installStatus: 'done' | 'doing';
      if (renewing) {
        const newGeneration = currentAwait.generation + 1;
        const baseline = this.buildRenewalBaseline(currentAwait, input.facts, collectorState);
        const awaitState = {
          v: 1 as const,
          generation: newGeneration,
          subjectRef: currentAwait.subjectRef,
          ownerFence: { kind: 'containing_task' as const, generation: newGeneration },
          baseline,
          continuation: {
            when: currentAwait.continuation.when,
            // biome-ignore lint/suspicious/noThenProperty: F280's frozen wait contract names this field `then`.
            then: currentAwait.continuation.then,
          },
          createdAt: this.now(),
          autoRenew: true,
          ...(currentAwait.expiresAt !== undefined ? { expiresAt: currentAwait.expiresAt } : {}),
          provenance: 'explicit_registration' as const,
        } as AwaitStateV1;
        installState = {
          ...replacement,
          await: awaitState,
          waitOutcome: { ...outcome, autoRenewed: true },
        } as AutomationState;
        installStatus = 'doing';
      } else {
        installState = replacement;
        installStatus = 'done';
      }

      await this.opts.taskStore.replaceAutomationStateIfGeneration(freshTask.id, {
        expectedGeneration: currentAwait.generation,
        expectedUpdatedAt: freshTask.updatedAt,
        automationState: installState,
        status: installStatus,
      });
    } else {
      // No match — advance baseline to include current facts so the next
      // observation starts from the correct frontier (no cursor gap).
      const refreshedBaseline = this.buildRenewalBaseline(currentAwait, input.facts, collectorState);
      await this.opts.taskStore.patchAutomationState(freshTask.id, {
        await: { ...currentAwait, baseline: refreshedBaseline },
      } as Partial<AutomationState>);
    }
  }

  private async terminalizeWithoutFacts(
    taskId: string,
    template: WaitTransitionEvent,
  ): Promise<GitHubWaitLifecycleResult> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const task = await this.opts.taskStore.get(taskId);
      if (!task || (task.kind !== 'pr_tracking' && task.kind !== 'issue_tracking')) {
        return { kind: 'not_tracked', reason: 'task_missing' };
      }
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
      // After atomic renewal, await.generation is N+1 while outcome.generation is N.
      // Use the current installed generation for the CAS, and preserve 'doing' status
      // when a next-gen await is active.
      const currentGen = current.automationState?.await?.generation ?? outcome.generation;
      const hasActiveWait = !!current.automationState?.await;
      await this.opts.taskStore.replaceAutomationStateIfGeneration(task.id, {
        expectedGeneration: currentGen,
        expectedUpdatedAt: current.updatedAt,
        automationState: marked as AutomationState,
        status: hasActiveWait ? 'doing' : 'done',
      });
    }
    this.opts.log.info(
      { taskId: task.id, outcomeId: outcome.outcomeId },
      '[F280] delivered compact GitHub wait outcome',
    );
    return { kind: 'notified', task, outcome, messageId: result.messageId, content };
  }

  /**
   * Build a fresh baseline for the next generation by merging the current
   * observation facts onto the previous baseline. Fields not present in facts
   * are carried forward — this prevents sibling predicates (e.g. CI after a
   * review wake) from becoming permanently unmatchable.
   */
  private buildRenewalBaseline(
    previousActive: AwaitStateV1,
    facts: GitHubWaitFacts,
    collectorState?: AutomationState,
  ): AwaitStateV1['baseline'] {
    const prev = previousActive.baseline;
    if ('headSha' in prev) {
      // PR tracking — merge facts onto previous baseline
      const prevReview = prev.review;
      // Collector state may have cursor values ahead of both baseline and facts —
      // use Math.max across all three sources for the full durable frontier.
      const collectorReview = (collectorState as Record<string, unknown> | undefined)?.review as
        | Record<string, number | undefined>
        | undefined;
      const review = facts.review
        ? {
            inlineCommentCursor: Math.max(
              prevReview?.inlineCommentCursor ?? 0,
              (collectorReview?.lastInlineCommentCursor as number) ?? 0,
            ),
            conversationCommentCursor: Math.max(
              computeConversationCursor(
                facts.review.resultConversationCommentCursor,
                facts.review.conversationComments,
                prevReview?.conversationCommentCursor ?? 0,
              ),
              (collectorReview?.lastConversationCommentCursor as number) ?? 0,
            ),
            decisionCursor: Math.max(
              facts.review.decisionCursor ?? 0,
              prevReview?.decisionCursor ?? 0,
              (collectorReview?.lastDecisionCursor as number) ?? 0,
            ),
            ...(facts.review.decision
              ? { decision: facts.review.decision }
              : prevReview?.decision
                ? { decision: prevReview.decision }
                : {}),
            ...(facts.review.threads
              ? { threads: facts.review.threads }
              : prevReview?.threads
                ? { threads: prevReview.threads }
                : {}),
            // Carry forward trigger fields for external-cloud-review-classifier:
            // resultTriggerCommentId identifies which comment started a cloud review cycle,
            // resultTriggerHeadSha pins the HEAD at which the trigger was observed.
            ...(facts.review.resultTriggerCommentId
              ? { resultTriggerCommentId: facts.review.resultTriggerCommentId }
              : prevReview?.resultTriggerCommentId
                ? { resultTriggerCommentId: prevReview.resultTriggerCommentId }
                : {}),
            ...(facts.review.resultTriggerCommentId
              ? { resultTriggerHeadSha: facts.headSha ?? prev.headSha }
              : prevReview?.resultTriggerHeadSha
                ? { resultTriggerHeadSha: prevReview.resultTriggerHeadSha }
                : {}),
          }
        : prevReview
          ? { ...prevReview }
          : undefined;
      return {
        capturedAt: this.now(),
        headSha: facts.headSha ?? prev.headSha,
        ...(review ? { review } : {}),
        ...(facts.ci
          ? { ci: { bucket: facts.ci.bucket, fingerprint: facts.ci.fingerprint } }
          : prev.ci
            ? { ci: { ...prev.ci } }
            : {}),
        ...(facts.conflict ? { conflict: facts.conflict } : prev.conflict ? { conflict: { ...prev.conflict } } : {}),
      };
    }
    // Issue tracking — merge onto previous issue baseline
    const maxCommentId = Math.max(0, ...(facts.issue?.comments ?? []).map((c) => c.id));
    const prevIssue = 'issue' in prev ? prev.issue : undefined;
    const collectorIssue = (collectorState as Record<string, unknown> | undefined)?.issue as
      | Record<string, number | string | undefined>
      | undefined;
    return {
      capturedAt: this.now(),
      issue: {
        lastCommentCursor: Math.max(
          maxCommentId || prevIssue?.lastCommentCursor || 0,
          (collectorIssue?.lastCommentCursor as number) ?? 0,
        ),
        state: facts.issue?.state ?? prevIssue?.state ?? 'open',
        ...(prevIssue?.authorLogin ? { authorLogin: prevIssue.authorLogin } : {}),
      },
    };
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
