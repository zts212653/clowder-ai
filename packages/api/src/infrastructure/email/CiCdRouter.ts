import type {
  CiAutomationState,
  DeliveryDecisionCueCarrierV1,
  ManagedWorkBinding,
  PrAutomationState,
  TaskItem,
} from '@cat-cafe/shared';
import { prSubjectKey } from '@cat-cafe/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { ITaskStore } from '../../domains/cats/services/stores/ports/TaskStore.js';
import type { ICommunityEventLog } from '../../domains/community/CommunityEventLog.js';
import type { ExternalReviewCoordinator } from '../../domains/community/external-review/ExternalReviewCoordinator.js';
import type {
  GitHubWaitLifecycleResult,
  GitHubWaitLifecycleService,
} from '../../domains/github-signals/GitHubWaitLifecycleService.js';
import type { CiBucket, CiPollResult, CiRouteResult } from './ci-cd-contract.js';
import { buildCiMessageContent, buildLifecycleMessageContent } from './ci-message-content.js';
import type { ConnectorDeliveryDeps } from './deliver-connector-message.js';

export { buildCiMessageContent, buildLifecycleMessageContent };
export type {
  CiBucket,
  CiCheckDetail,
  CiExecutionFailure,
  CiPollResult,
  CiRouteResult,
} from './ci-cd-contract.js';

interface ICommunityProjectorMin {
  rebuild(subjectKey: string): Promise<void>;
}

export interface TerminalEffectCommit {
  readonly idempotencyKey: string;
}

type TerminalPrState = 'merged' | 'closed';
type TerminalEffect = 'prLifecycle' | 'distillation' | 'communityProjection';
type TerminalEffectReceipt = NonNullable<NonNullable<PrAutomationState['ci']>['terminalEffects']>;

interface TerminalRecoveryContext {
  readonly task: TaskItem;
  readonly terminal: TerminalPrState;
  readonly effects: TerminalEffectReceipt;
}

function terminalPrState(poll: CiPollResult): TerminalPrState | undefined {
  return poll.prState === 'merged' || poll.prState === 'closed' ? poll.prState : undefined;
}

export function buildDeliveryDecisionCueCarrier(
  poll: CiPollResult,
  task: Pick<import('./ci-cd-contract.js').TrackedTaskLike, 'automationState'>,
  occurredAt: number,
): DeliveryDecisionCueCarrierV1 | null {
  const waitsForCi = task.automationState?.await?.continuation.when.some(
    (predicate) => predicate.kind === 'pr_ci_terminal',
  );
  if (
    poll.prState !== 'open' ||
    poll.aggregateBucket !== 'fail' ||
    !waitsForCi ||
    task.automationState?.ci?.headSha !== poll.headSha ||
    !poll.checks.some((check) => check.executionFailure === 'billing_spending_limit_zero_step')
  ) {
    return null;
  }
  return {
    v: 1,
    producer: 'github_ci',
    producerProvenance: 'server_github_ci',
    repoFullName: poll.repoFullName,
    prNumber: poll.prNumber,
    headSha: poll.headSha,
    phase: 'merge_gate',
    gateOutcome: 'source_evidence_complete',
    externalCondition: 'billing_spending_limit_zero_step',
    candidateAction: 'merge',
    occurredAt,
  };
}

export function classifyCiWaitBucket(poll: CiPollResult): CiBucket {
  if (poll.aggregateBucket !== 'fail') return poll.aggregateBucket;
  const failedChecks = poll.checks.filter((check) => check.bucket === 'fail');
  return failedChecks.length > 0 &&
    failedChecks.every((check) => check.executionFailure === 'billing_spending_limit_zero_step')
    ? 'external_infrastructure'
    : 'fail';
}

export interface CiCdRouterOptions {
  readonly taskStore: ITaskStore;
  readonly deliveryDeps: ConnectorDeliveryDeps;
  readonly waitLifecycle: GitHubWaitLifecycleService;
  readonly log: FastifyBaseLogger;
  readonly notifySkip?: (threadId: string, reason: string) => void;
  readonly onPrLifecycle?: (event: {
    type: 'merge' | 'revert';
    ref: string;
    outcome: 'success' | 'failure';
    threadId: string;
    idempotencyKey: string;
    attribution: { kind: 'managed_attributed'; binding: ManagedWorkBinding } | { kind: 'managed_unattributed' };
  }) => TerminalEffectCommit | Promise<TerminalEffectCommit>;
  readonly eventLog?: ICommunityEventLog;
  readonly projector?: ICommunityProjectorMin;
  readonly externalReviewCoordinator?: Pick<ExternalReviewCoordinator, 'recordCi'>;
  readonly distillationCheckpoint?: import('../../infrastructure/distillation/DistillationCheckpoint.js').DistillationCheckpoint;
  readonly now?: () => number;
}

export const EMPTY_ROLLUP_STABILITY_MS = 60_000;

type RollupObservation = NonNullable<CiAutomationState['rollupObservation']>;

/**
 * GitHub reports [] both when a repository has no checks and during the brief
 * window before checks appear for a fresh HEAD. Require the exact same HEAD to
 * remain empty for a full poll interval; any non-empty observation resets the
 * streak. The observation is persisted with the PR tracking collector state.
 */
export function settleEmptyCheckRollup(
  poll: CiPollResult,
  previous: RollupObservation | undefined,
  now: number,
): { readonly poll: CiPollResult; readonly observation: RollupObservation } {
  if (poll.prState !== 'open' || poll.checkRollup !== 'empty') {
    return {
      poll,
      observation: { headSha: poll.headSha, state: 'present', streakStartedAt: now },
    };
  }

  const streakStartedAt =
    previous?.headSha === poll.headSha && previous.state === 'empty' ? previous.streakStartedAt : now;
  const aggregateBucket = now - streakStartedAt >= EMPTY_ROLLUP_STABILITY_MS ? 'pass' : 'pending';
  return {
    poll: { ...poll, aggregateBucket },
    observation: { headSha: poll.headSha, state: 'empty', streakStartedAt },
  };
}

function routeFromLifecycle(
  result: GitHubWaitLifecycleResult,
  bucket: CiBucket,
  prState?: 'merged' | 'closed',
): CiRouteResult {
  if (result.kind === 'notified') {
    if (prState) {
      return {
        kind: 'lifecycle',
        threadId: result.task.threadId,
        catId: result.task.ownerCatId ?? '',
        messageId: result.messageId,
        prState,
        content: result.content,
      };
    }
    return {
      kind: 'notified',
      threadId: result.task.threadId,
      catId: result.task.ownerCatId ?? '',
      messageId: result.messageId,
      bucket,
      content: result.content,
      headSha: result.outcome.subjectRef,
    };
  }
  return {
    kind: result.kind === 'deduped' ? 'deduped' : 'skipped',
    reason: result.reason,
  };
}

export class CiCdRouter {
  private readonly now: () => number;

  constructor(private readonly opts: CiCdRouterOptions) {
    this.now = opts.now ?? Date.now;
  }

  async route(poll: CiPollResult): Promise<CiRouteResult> {
    const sk = prSubjectKey(poll.repoFullName, poll.prNumber);
    const task = await this.opts.taskStore.getBySubject(sk);
    if (!task) return { kind: 'skipped', reason: `No tracking task for ${poll.repoFullName}#${poll.prNumber}` };

    const settled = settleEmptyCheckRollup(poll, task.automationState?.ci?.rollupObservation, this.now());
    const observedPoll = settled.poll;
    const terminal = terminalPrState(observedPoll);
    const disabled = await this.skipDisabledCi(task);
    if (disabled) return disabled;
    await this.recordExternalReviewCi(observedPoll, task, sk);

    const waitBucket = classifyCiWaitBucket(observedPoll);
    const fingerprint = `${observedPoll.headSha}:${waitBucket}`;
    const deliveryDecision = buildDeliveryDecisionCueCarrier(observedPoll, task, this.now());
    let lifecycle: GitHubWaitLifecycleResult;
    try {
      lifecycle = await this.observeWait(
        observedPoll,
        task,
        waitBucket,
        fingerprint,
        terminal,
        deliveryDecision,
        settled.observation,
      );
    } catch (error) {
      // The wait transition is durable before connector delivery. Recover world
      // truth from that durable terminal state even when delivery throws.
      if (terminal) await this.recoverTerminalSideEffects(observedPoll, task.id, sk);
      throw error;
    }

    if (terminal) {
      await this.recoverTerminalSideEffects(observedPoll, task.id, sk);
      if (lifecycle.kind !== 'notified') {
        await this.opts.taskStore.update(task.id, { status: 'done' });
      }
    }
    return routeFromLifecycle(lifecycle, waitBucket, terminal);
  }

  private async skipDisabledCi(task: TaskItem): Promise<CiRouteResult | null> {
    if (task.automationState?.ci?.enabled !== false) return null;
    if (!task.automationState.ci.skipNotified) {
      this.opts.notifySkip?.(task.threadId, 'ci_automation_disabled');
      await this.opts.taskStore.patchAutomationState(task.id, { ci: { skipNotified: true } });
    }
    return { kind: 'skipped', reason: 'CI collection disabled' };
  }

  private async recordExternalReviewCi(poll: CiPollResult, task: TaskItem, sk: string): Promise<void> {
    if (!task.ownerCatId) return;
    try {
      await this.opts.externalReviewCoordinator?.recordCi(poll, {
        threadId: task.threadId,
        catId: task.ownerCatId,
        userId: task.userId ?? '',
      });
    } catch (error) {
      this.opts.log.warn({ error, sk }, '[F168] CI readiness bookkeeping failed');
    }
  }

  private observeWait(
    poll: CiPollResult,
    task: TaskItem,
    waitBucket: CiBucket,
    fingerprint: string,
    terminal: TerminalPrState | undefined,
    deliveryDecision: DeliveryDecisionCueCarrierV1 | null,
    rollupObservation: RollupObservation,
  ): Promise<GitHubWaitLifecycleResult> {
    return this.opts.waitLifecycle.observe({
      taskId: task.id,
      facts: {
        headSha: poll.headSha,
        ci: {
          bucket: waitBucket,
          fingerprint,
          blockerCount: poll.checks.filter((check) => check.bucket === 'fail').length,
        },
      },
      collectorPatch: {
        ci: {
          headSha: poll.headSha,
          lastFingerprint: fingerprint,
          lastBucket: waitBucket,
          rollupObservation,
          ...(terminal ? { prState: terminal } : {}),
        },
      },
      ...(terminal ? { subjectState: terminal } : {}),
      ...(deliveryDecision ? { deliveryExtra: { memoryCue: { deliveryDecision } } } : {}),
    });
  }

  private async recoverTerminalSideEffects(poll: CiPollResult, taskId: string, sk: string): Promise<void> {
    const terminal = terminalPrState(poll);
    if (!terminal) return;
    let context = await this.loadTerminalRecoveryContext(taskId, terminal);
    if (!context || context.effects.completedAt !== undefined) return;

    const lifecycleRequired = terminal === 'merged' && this.opts.onPrLifecycle !== undefined;
    if (lifecycleRequired) {
      context = await this.applyTerminalEffect(context, 'prLifecycle', sk, (task) =>
        this.emitPrLifecycleEffect(task, sk),
      );
    }

    const featureSource = context.task.title ?? '';
    const featureMatch = featureSource.match(/\b[Ff](\d{2,4})\b/);
    const distillationRequired =
      terminal === 'merged' && this.opts.distillationCheckpoint !== undefined && featureMatch !== null;
    if (distillationRequired) {
      context = await this.applyTerminalEffect(context, 'distillation', sk, (task) =>
        this.emitDistillationEffect(poll, task, featureMatch),
      );
    }

    const communityRequired = this.opts.eventLog !== undefined;
    if (communityRequired) {
      context = await this.applyTerminalEffect(context, 'communityProjection', sk, () =>
        this.emitCommunityEffect(poll, sk, terminal),
      );
    }

    const requiredEffects: TerminalEffect[] = [
      ...(lifecycleRequired ? (['prLifecycle'] as const) : []),
      ...(distillationRequired ? (['distillation'] as const) : []),
      ...(communityRequired ? (['communityProjection'] as const) : []),
    ];
    if (requiredEffects.every((effect) => context.effects[effect] === true)) {
      await this.markTerminalEffect(taskId, terminal, 'completedAt');
    }
  }

  private async loadTerminalRecoveryContext(
    taskId: string,
    terminal: TerminalPrState,
  ): Promise<TerminalRecoveryContext | null> {
    const task = await this.opts.taskStore.get(taskId);
    if (!task || task.automationState?.ci?.prState !== terminal) return null;
    const existing = task.automationState.ci.terminalEffects;
    return {
      task,
      terminal,
      effects: existing?.prState === terminal ? existing : { prState: terminal },
    };
  }

  private async applyTerminalEffect(
    context: TerminalRecoveryContext,
    effect: TerminalEffect,
    sk: string,
    run: (task: TaskItem) => Promise<void>,
  ): Promise<TerminalRecoveryContext> {
    if (context.effects[effect] === true) return context;
    try {
      await run(context.task);
      const updated = await this.markTerminalEffect(context.task.id, context.terminal, effect);
      return (await this.loadTerminalRecoveryContext(updated?.id ?? context.task.id, context.terminal)) ?? context;
    } catch (error) {
      this.opts.log.warn({ error, sk, effect }, '[CiCdRouter] terminal world-truth effect failed');
      return context;
    }
  }

  private async emitPrLifecycleEffect(task: TaskItem, sk: string): Promise<void> {
    if (!this.opts.onPrLifecycle) return;
    const binding = await this.opts.taskStore.getManagedWorkBinding(task.id);
    const idempotencyKey = `pr:merge:${sk}:success`;
    const committed = await this.opts.onPrLifecycle({
      type: 'merge',
      ref: sk,
      outcome: 'success',
      threadId: task.threadId,
      idempotencyKey,
      attribution: binding ? { kind: 'managed_attributed', binding } : { kind: 'managed_unattributed' },
    });
    if (committed.idempotencyKey !== idempotencyKey) {
      throw new Error(`PR lifecycle sink committed unexpected key ${committed.idempotencyKey}`);
    }
  }

  private async emitDistillationEffect(
    poll: CiPollResult,
    task: TaskItem,
    featureMatch: RegExpMatchArray,
  ): Promise<void> {
    if (!this.opts.distillationCheckpoint) return;
    const phaseMatch = task.title.match(/[Pp]hase\s+([A-Z])/i);
    const committed = await this.opts.distillationCheckpoint.onFeatPhaseClose({
      prNumber: poll.prNumber,
      repoFullName: poll.repoFullName,
      authorCatId: task.ownerCatId ?? 'unknown',
      threadId: task.threadId,
      featureId: `F${featureMatch[1]}`,
      phaseLabel: phaseMatch?.[1] ?? 'unknown',
    });
    const expectedSourceId = `feat-phase-close:F${featureMatch[1]}:${phaseMatch?.[1] ?? 'unknown'}`;
    if (committed.sourceId !== expectedSourceId) {
      throw new Error(`Distillation checkpoint committed unexpected source ${committed.sourceId}`);
    }
  }

  private async emitCommunityEffect(poll: CiPollResult, sk: string, terminal: TerminalPrState): Promise<void> {
    if (!this.opts.eventLog) return;
    const communityEvent = {
      sourceEventId: `lifecycle:${sk}:${terminal}`,
      subjectKey: sk,
      kind: (terminal === 'merged' ? 'pr.merged' : 'pr.closed') as 'pr.merged' | 'pr.closed',
      classification: 'state-changing' as const,
      payload: {
        prState: terminal,
        repoFullName: poll.repoFullName,
        prNumber: poll.prNumber,
      },
      at: Date.now(),
    };
    await this.opts.eventLog.append(communityEvent);
    // Projection is rebuilt from the idempotent event log rather than applying
    // an event twice when append won but the previous projector attempt crashed.
    if (this.opts.projector) await this.opts.projector.rebuild(sk);
  }

  private async markTerminalEffect(
    taskId: string,
    terminal: TerminalPrState,
    effect: TerminalEffect | 'completedAt',
  ): Promise<TaskItem | null> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.opts.taskStore.get(taskId);
      const state = current?.automationState as PrAutomationState | undefined;
      if (!current || state?.ci?.prState !== terminal) return null;
      const existing =
        state.ci.terminalEffects?.prState === terminal ? state.ci.terminalEffects : { prState: terminal };
      const terminalEffects = {
        ...existing,
        ...(effect === 'completedAt' ? { completedAt: Date.now() } : { [effect]: true as const }),
      };
      const updatedState: PrAutomationState = {
        ...state,
        ci: { ...state.ci, terminalEffects },
      };
      const installed = await this.opts.taskStore.replaceAutomationStateIfGeneration(taskId, {
        expectedGeneration: state.await?.generation ?? state.waitOutcome?.generation ?? null,
        expectedUpdatedAt: current.updatedAt,
        automationState: updatedState,
      });
      if (installed) return installed;
    }
    return null;
  }
}
