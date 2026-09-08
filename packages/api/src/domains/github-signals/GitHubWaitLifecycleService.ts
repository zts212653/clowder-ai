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
import { automationGeneration } from '../cats/services/stores/ports/TaskAutomationState.js';
import type { ITaskStore } from '../cats/services/stores/ports/TaskStore.js';
import {
  advanceGitHubTrackingBaseline,
  GITHUB_TRACKING_EVENT_KINDS,
  type GitHubTrackingEvent,
  matchGitHubTrackingEvents,
} from './GitHubTrackingEvent.js';
import { type GitHubWaitFacts, matchGitHubWaitPredicates } from './GitHubWaitPredicateCatalog.js';
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
  readonly events?: readonly GitHubTrackingEvent[];
  readonly collectorPatch?: GitHubCollectorPatch;
  readonly subjectState?: 'merged' | 'closed';
  readonly at?: number;
  /** Source-owned, typed metadata for the connector message created by this observation. */
  readonly deliveryExtra?: ConnectorDeliveryInput['extra'];
  /**
   * Action-time review-history observation.
   *
   * R33 correction: it is no longer projected "only through the outcome nextStep". A pause_once
   * brake is also stamped structurally onto the outcome (`autoWakeSuppressed`), because the
   * outcome is SHARED — whichever poll re-publishes it must be able to honour the decision
   * without reading it back out of rendered prose.
   */
  readonly reviewLoopBrake?: GitHubReviewLoopBrake;
}

/**
 * Did THIS call's `input.events` reach durable state — folded into a baseline, captured by an
 * outcome, or deliberately consumed because nothing will ever match them?
 *
 * sol R32: this used to live only on `notified`, so the caller treated every other shape as
 * "evaluated" by default. A CAS-exhausted `deduped` installs nothing at all, and the caller
 * still advanced its source cursor past feedback no baseline had ever seen. The question is
 * orthogonal to whether a message went out, so it belongs on every variant, defaults to false,
 * and every site that claims `true` has to point at the write that earned it.
 */
export type GitHubWaitLifecycleResult =
  | ({ readonly kind: 'not_tracked' | 'state_only' | 'deduped'; readonly reason: string } & {
      readonly observationEvaluated: boolean;
    })
  | {
      readonly kind: 'notified';
      readonly task: TaskItem;
      readonly outcome: WaitOutcomeV1;
      readonly messageId: string;
      readonly content: string;
      /**
       * Did THIS call's `input.events` actually get evaluated against the wait?
       *
       * `notified` alone cannot answer that. When a prior outcome is still undelivered, observe
       * re-publishes it and never reads the events it was handed — the caller then sees a
       * successful delivery and commits its source cursor past feedback nothing ever looked at.
       * A caller that advances durable state must gate on this, not on `kind`.
       */
      readonly observationEvaluated: boolean;
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
  /**
   * F280 A30: our own GitHub login, so the audience filter can tell "mine" from "the PR
   * author's" from "a third party's". Absent means the role is unresolved and the filter
   * falls back to ON — A26: muting a real signal is worse than one extra notification.
   */
  readonly selfGitHubLogin?: () => string | undefined;
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

/** #1392: conversation-comment frontier used when building a renewal baseline. */
function computeCommentCursor(
  explicitCursor: number | undefined,
  comments: readonly { readonly id: number }[] | undefined,
  fallback: number,
): number {
  // #1392 P2: strict union of every comment frontier for one surface. An explicit result cursor
  // must NOT shadow a larger same-batch comment id (or the previous frontier) — otherwise the next
  // generation re-matches a comment already seen. Take the max of all three.
  const commentsMax = comments && comments.length > 0 ? Math.max(...comments.map((c) => c.id)) : 0;
  return Math.max(fallback, explicitCursor ?? 0, commentsMax);
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
        return { kind: 'not_tracked', reason: `No GitHub wait task ${input.taskId}`, observationEvaluated: false };
      }

      const existingPending = pendingOutcome(task);
      // sol R30: the events handed to THIS call are not read on this branch. Since #1394's
      // auto-renew installs outcome N and await N+1 atomically, "pending N while N+1 is live" is
      // an ordinary long-lived state rather than a rare race — so this branch is on the main path
      // and must tell the caller its cursor has earned nothing.
      if (existingPending) return this.publishPending(task, existingPending, false, input.deliveryExtra);

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
          // The collector state — cursors included — was installed immediately above.
          return { kind: 'state_only', reason: 'subject_terminal_without_active_wait', observationEvaluated: true };
        }
        if (input.collectorPatch) {
          await this.opts.taskStore.patchAutomationState(task.id, input.collectorPatch as Partial<AutomationState>);
        }
        // No wait exists, so nothing will ever match these events. Consumed by decision —
        // holding the caller's cursor here would loop it forever on the same items.
        return { kind: 'state_only', reason: 'no_active_wait', observationEvaluated: true };
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
      // The turn clock is only meaningful on a pass that also RAN the turn-aware matcher.
      // A CI or conflict observation carries no events and never evaluates turns; letting it
      // advance the clock would retire an open turn that nobody reported — the A28 signal
      // would be deleted between two polls instead of delivered.
      const turnClock = input.events ? { now: at } : undefined;
      const eventMatches = input.events
        ? matchGitHubTrackingEvents(active.continuation.when, active.baseline, input.events, {
            ...turnClock,
            audience: {
              ...(this.opts.selfGitHubLogin?.() ? { selfLogin: this.opts.selfGitHubLogin() } : {}),
              ...('prAuthorLogin' in active.baseline && active.baseline.prAuthorLogin
                ? { prAuthorLogin: active.baseline.prAuthorLogin }
                : {}),
            },
          })
        : [];
      const typedPredicates = input.events
        ? active.continuation.when.filter((predicate) => !GITHUB_TRACKING_EVENT_KINDS.has(predicate.kind))
        : active.continuation.when;
      const matched = [...eventMatches, ...matchGitHubWaitPredicates(typedPredicates, active.baseline, input.facts)];
      let transition: WaitTransitionEvent;
      if (input.subjectState) {
        // Terminal truth ends the wait, but it must not erase events collected in the same
        // observation. The terminal outcome is the last delivery opportunity for those events.
        transition = {
          type: 'subject_terminal',
          generation: active.generation,
          at,
          subjectState: input.subjectState,
          matched,
        };
      } else {
        // #1392 AC-2: no deadline (expiresAt undefined) ⇒ never time-out; stay pending until a match.
        if (matched.length === 0 && (active.expiresAt === undefined || at < active.expiresAt)) {
          const advancedState = {
            ...collectorState,
            await: {
              ...active,
              baseline: advanceGitHubTrackingBaseline(
                this.buildRenewalBaseline(active, input.facts, collectorState),
                input.events ?? [],
                turnClock,
              ),
            },
          } as AutomationState;
          const installed = await this.opts.taskStore.replaceAutomationStateIfGeneration(task.id, {
            expectedGeneration: active.generation,
            expectedUpdatedAt: task.updatedAt,
            automationState: advancedState,
            status: task.status,
          });
          if (!installed) continue;
          // The advanced baseline, built from these very events, was installed above.
          return { kind: 'state_only', reason: 'predicates_not_matched', observationEvaluated: true };
        }
        transition = {
          type: 'predicates_matched',
          generation: active.generation,
          at,
          matched,
        };
      }

      const transitioned = transitionWaitState(transitionState, transition);
      if (!transitioned.applied) {
        return { kind: 'deduped', reason: transitioned.reason, observationEvaluated: false };
      }
      const replacement = transitioned.state as AutomationState;
      const outcome = replacement.waitOutcome;
      if (!outcome) return { kind: 'state_only', reason: 'terminalized_without_outcome', observationEvaluated: false };

      // #1392 AC-1: on a predicate MATCH with autoRenew, atomically install gen N+1
      // (fresh baseline, same when/then/expiresAt) in the SAME CAS as the delivered
      // outcome — a TaskStore-only generation transition. Never renew on expiry,
      // terminal, cancel, or subject-terminal. Delivery reliability stays with #1356/#1398.
      const renewing =
        outcome.delivery === 'pending' &&
        outcome.reason === 'matched' &&
        active.autoRenew === true &&
        !outcome.terminalSubjectState;

      let installState: AutomationState = replacement;
      let installStatus: 'done' | 'doing' = 'done';
      // sol R32: the R4 pause belongs to THIS outcome, not to whichever signal a later caller
      // happens to hold. Stamped here so a re-published N keeps its own suppression instead of
      // being auto-woken because a connector hiccup made someone re-deliver it.
      let deliverOutcome: WaitOutcomeV1 =
        input.reviewLoopBrake?.kind === 'pause_once' ? { ...outcome, autoWakeSuppressed: true } : outcome;
      if (renewing) {
        const newGeneration = active.generation + 1;
        const awaitState = {
          v: 1 as const,
          generation: newGeneration,
          subjectRef: active.subjectRef,
          ownerFence: { kind: 'containing_task' as const, generation: newGeneration },
          baseline: advanceGitHubTrackingBaseline(
            this.buildRenewalBaseline(active, input.facts, collectorState),
            input.events ?? [],
            turnClock,
          ),
          continuation: {
            when: active.continuation.when,
            // biome-ignore lint/suspicious/noThenProperty: F280's frozen wait contract names this field `then`.
            then: active.continuation.then,
          },
          createdAt: this.now(),
          autoRenew: true,
          // #1392 AC-2: renewal reuses the ORIGINAL absolute expiresAt — it never extends.
          ...(active.expiresAt !== undefined ? { expiresAt: active.expiresAt } : {}),
          provenance: 'explicit_registration' as const,
        } as AwaitStateV1;
        deliverOutcome = { ...deliverOutcome, autoRenewed: true };
        installState = { ...replacement, await: awaitState, waitOutcome: deliverOutcome } as AutomationState;
        installStatus = 'doing';
      }

      const installed = await this.opts.taskStore.replaceAutomationStateIfGeneration(task.id, {
        expectedGeneration: active.generation,
        expectedUpdatedAt: task.updatedAt,
        automationState: installState,
        status: installStatus,
      });
      if (!installed) continue;
      const installedOutcome = installed.automationState?.waitOutcome ?? deliverOutcome;
      await this.appendLifecycleEvent(installed, installedOutcome);
      if (installedOutcome.delivery !== 'pending') {
        return { kind: 'state_only', reason: installedOutcome.reason, observationEvaluated: true };
      }
      if (renewing) {
        this.opts.log.info(
          { taskId: task.id, newGeneration: active.generation + 1 },
          '[#1392] auto-renewed wait tracking with a fresh baseline',
        );
      }
      return this.publishPending(installed, installedOutcome, true, input.deliveryExtra);
    }
    return { kind: 'deduped', reason: 'generation_changed_concurrently', observationEvaluated: false };
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
      return { kind: 'not_tracked', reason: 'task_missing', observationEvaluated: false };
    }
    const outcome = task.automationState?.waitOutcome;
    if (!outcome) return { kind: 'state_only', reason: 'nothing_to_recover', observationEvaluated: false };
    await this.appendLifecycleEvent(task, outcome);
    // Recovery carries no observation, so it can never authorize a cursor advance.
    if (outcome.delivery === 'pending') return this.publishPending(task, outcome, false);
    return { kind: 'state_only', reason: outcome.reason, observationEvaluated: false };
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
      if (!task || (task.kind !== 'pr_tracking' && task.kind !== 'issue_tracking')) {
        return { kind: 'not_tracked', reason: 'task_missing', observationEvaluated: false };
      }
      const state = task.automationState;
      const active = state?.await;
      if (!active) return { kind: 'deduped', reason: 'no_active_wait', observationEvaluated: false };
      const event = { ...template, generation: active.generation } as WaitTransitionEvent;
      const transitioned = transitionWaitState(state, event);
      if (!transitioned.applied) return { kind: 'deduped', reason: transitioned.reason, observationEvaluated: false };
      const installed = await this.opts.taskStore.replaceAutomationStateIfGeneration(task.id, {
        expectedGeneration: active.generation,
        expectedUpdatedAt: task.updatedAt,
        automationState: transitioned.state as AutomationState,
        status: 'done',
      });
      if (!installed) continue;
      const outcome = installed.automationState?.waitOutcome;
      if (!outcome) return { kind: 'state_only', reason: 'terminalized_without_outcome', observationEvaluated: false };
      await this.appendLifecycleEvent(installed, outcome);
      return { kind: 'state_only', reason: outcome.reason, observationEvaluated: false };
    }
    return { kind: 'deduped', reason: 'generation_changed_concurrently', observationEvaluated: false };
  }

  // #1392 AC-5: fresh baseline for gen N+1 — advance every cursor past the current
  // frontier (previous ∪ facts) so the next generation only matches NEW events. TaskStore-only.
  private buildRenewalBaseline(
    previousActive: AwaitStateV1,
    facts: GitHubWaitFacts,
    collectorState?: AutomationState,
  ): AwaitStateV1['baseline'] {
    const prev = previousActive.baseline;
    if ('headSha' in prev) {
      const prevReview = prev.review;
      const collectorReview = (collectorState as Record<string, unknown> | undefined)?.review as
        | Record<string, number | undefined>
        | undefined;
      // #1392 P2: the renewal review baseline is a strict union of previous ∪ facts ∪ collector for
      // every frontier — even when a NON-review signal (CI, conflict) triggered this renewal and
      // facts.review is absent. Copying prevReview verbatim in that case would drop collector
      // frontiers advanced by intervening observes, so the next generation would re-match seen
      // review events. Always fold the collector in.
      const reviewFacts = facts.review;
      const review =
        reviewFacts || prevReview || collectorReview
          ? {
              // #1394: fold the OBSERVED inline comments in, exactly as the conversation
              // frontier already does. Slice 6a made inline comments matchable but left this
              // arm reading only the collector cursor, so the inline comment that fired a
              // wake could fire the very next generation again whenever the collector lagged.
              // Every matchable surface must advance its own frontier on renewal.
              inlineCommentCursor: Math.max(
                prevReview?.inlineCommentCursor ?? 0,
                (collectorReview?.lastInlineCommentCursor as number) ?? 0,
                computeCommentCursor(undefined, reviewFacts?.inlineComments, 0),
              ),
              conversationCommentCursor: Math.max(
                prevReview?.conversationCommentCursor ?? 0,
                computeCommentCursor(undefined, reviewFacts?.conversationComments, 0),
                (collectorReview?.lastConversationCommentCursor as number) ?? 0,
              ),
              decisionCursor: Math.max(
                reviewFacts?.decisionCursor ?? 0,
                prevReview?.decisionCursor ?? 0,
                (collectorReview?.lastDecisionCursor as number) ?? 0,
              ),
              ...(reviewFacts?.decision
                ? { decision: reviewFacts.decision }
                : prevReview?.decision
                  ? { decision: prevReview.decision }
                  : {}),
            }
          : undefined;
      return {
        capturedAt: this.now(),
        headSha: facts.headSha ?? prev.headSha,
        // A30: the PR author is FROZEN at registration and must survive every renewal. It is
        // not a frontier that an observation can refresh — nothing in `facts` carries it — so
        // rebuilding the baseline without it silently deletes the tracker's role. The audience
        // filter then fails open by design (A26 ranks a muted real signal below extra noise),
        // and a non-author tracker starts waking on every third party from the first quiet poll
        // onward. That is the exact defect #1394 exists to remove, coming back through renewal.
        // The issue branch below already carried its author forward; this one did not.
        ...(prev.prAuthorLogin ? { prAuthorLogin: prev.prAuthorLogin } : {}),
        ...(review ? { review } : {}),
        ...(facts.ci
          ? { ci: { bucket: facts.ci.bucket, fingerprint: facts.ci.fingerprint } }
          : prev.ci
            ? { ci: { ...prev.ci } }
            : {}),
        ...(facts.conflict ? { conflict: facts.conflict } : prev.conflict ? { conflict: { ...prev.conflict } } : {}),
        ...(facts.base ? { base: facts.base } : prev.base ? { base: { ...prev.base } } : {}),
        // F280 section 4b: a renewal must carry OPEN bot turns forward. Dropping them here
        // would make every renewal silently forget that a bot was asked and never answered —
        // A28 would then be a capability that exists in code and never fires in production.
        ...(prev.botTurns ? { botTurns: prev.botTurns } : {}),
      };
    }
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

  private async appendLifecycleEvent(task: TaskItem, outcome: WaitOutcomeV1): Promise<void> {
    if (!this.opts.eventLog) return;
    try {
      await this.opts.eventLog.append(lifecycleEvent(task, outcome));
    } catch (error) {
      this.opts.log.warn({ error, taskId: task.id, outcomeId: outcome.outcomeId }, '[F280] wait event append deferred');
    }
  }

  /**
   * `observationEvaluated` is REQUIRED, not defaulted: every call site has to state whether the
   * events it was holding were evaluated. A default would be inherited silently by the next one,
   * and the whole defect here was a re-publish being mistaken for an evaluation.
   */
  private async publishPending(
    task: TaskItem,
    outcome: WaitOutcomeV1,
    observationEvaluated: boolean,
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
      // #1392 P1: confirm delivery against the CURRENT active generation, not this outcome's
      // original generation. After an auto-renew the store already advanced to gen N+1 (the fresh
      // await) while this outcome is gen N; a CAS on gen N would deterministically fail, leaving the
      // outcome `pending` forever and re-delivering it on every observe. Likewise keep the task
      // `doing` whenever a live await remains (renewed) — forcing `done` would stop the poller.
      const activeAwait = current.automationState?.await;
      await this.opts.taskStore.replaceAutomationStateIfGeneration(task.id, {
        expectedGeneration: automationGeneration(current.automationState) ?? outcome.generation,
        expectedUpdatedAt: current.updatedAt,
        automationState: marked as AutomationState,
        status: activeAwait ? 'doing' : 'done',
      });
    }
    this.opts.log.info(
      { taskId: task.id, outcomeId: outcome.outcomeId },
      '[F280] delivered compact GitHub wait outcome',
    );
    return { kind: 'notified', task, outcome, messageId: result.messageId, content, observationEvaluated };
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
        return { kind: 'deduped', reason: 'outcome_changed_concurrently', observationEvaluated: false };
      }
      if (currentOutcome.delivery !== 'pending') {
        return { kind: 'state_only', reason: currentOutcome.reason, observationEvaluated: false };
      }
      if (parseWaitOwnerFence(currentOutcome.ownerFence)) {
        return this.publishPending(current, currentOutcome, false);
      }
      const marked = markWaitOutcomeLegacyUnfenced(current.automationState as PrAutomationState, outcome.outcomeId);
      const installed = await this.opts.taskStore.replaceAutomationStateIfGeneration(task.id, {
        expectedGeneration: outcome.generation,
        expectedUpdatedAt: current.updatedAt,
        automationState: marked as PrAutomationState,
        status: 'done',
      });
      if (installed) return { kind: 'state_only', reason: 'legacy_unfenced', observationEvaluated: false };
    }
    return { kind: 'deduped', reason: 'generation_changed_concurrently', observationEvaluated: false };
  }
}
