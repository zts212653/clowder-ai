/** F133 + clowder-ai#320: route CI/CD results using the unified TaskStore. */
import type { ConnectorSource, DeliveryDecisionCueCarrierV1, ManagedWorkBinding } from '@cat-cafe/shared';
import { prSubjectKey } from '@cat-cafe/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { ITaskStore } from '../../domains/cats/services/stores/ports/TaskStore.js';
import type { ICommunityEventLog } from '../../domains/community/CommunityEventLog.js';
import type {
  ExternalReviewCoordinator,
  ExternalReviewCoordinatorResult,
} from '../../domains/community/external-review/ExternalReviewCoordinator.js';
import {
  type CiPollResult,
  type CiRouteResult,
  getConnectorDeliveryTarget,
  type TrackedTaskLike,
} from './ci-cd-contract.js';
import { buildCiMessageContent, buildLifecycleMessageContent } from './ci-message-content.js';
import type { ConnectorDeliveryDeps } from './deliver-connector-message.js';
import { deliverConnectorMessage } from './deliver-connector-message.js';

export { buildCiMessageContent, buildLifecycleMessageContent };
export type {
  CiBucket,
  CiCheckDetail,
  CiExecutionFailure,
  CiPollResult,
  CiRouteResult,
} from './ci-cd-contract.js';

interface ICommunityProjectorMin {
  apply(event: Parameters<ICommunityEventLog['append']>[0]): Promise<void>;
}

export function buildDeliveryDecisionCueCarrier(
  poll: CiPollResult,
  task: Pick<TrackedTaskLike, 'automationState'>,
  occurredAt: number,
): DeliveryDecisionCueCarrierV1 | null {
  if (
    poll.prState !== 'open' ||
    poll.aggregateBucket !== 'fail' ||
    task.automationState?.intent !== 'merge' ||
    task.automationState.ci?.headSha !== poll.headSha ||
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
export interface CiCdRouterOptions {
  readonly taskStore: ITaskStore;
  readonly deliveryDeps: ConnectorDeliveryDeps;
  readonly log: FastifyBaseLogger;
  readonly notifySkip?: (threadId: string, reason: string) => void;
  /** F192 Phase G: emit A1 world truth signal when PR merges/reverts */
  readonly onPrLifecycle?: (event: {
    type: 'merge' | 'revert';
    ref: string;
    outcome: 'success' | 'failure';
    threadId: string;
    attribution: { kind: 'managed_attributed'; binding: ManagedWorkBinding } | { kind: 'managed_unattributed' };
  }) => void | Promise<void>;
  /**
   * F168 Phase A (P1-3 fix): canonical PR lifecycle event emission point.
   * CiCdRouter is first to detect merged/closed; ReviewFeedbackTaskSpec may race.
   * sourceEventId dedup ensures double-fire is safe.
   */
  readonly eventLog?: ICommunityEventLog;
  /** Optional projector to apply the emitted event immediately after append. */
  readonly projector?: ICommunityProjectorMin;
  /** F168 Phase F-Step3: current-head readiness and once-per-head reviewer wake. */
  readonly externalReviewCoordinator?: Pick<ExternalReviewCoordinator, 'recordCi'>;
  /**
   * F208 Phase E AC-E2: distillation checkpoint for feat-phase-close.
   * CiCdRouter is the canonical first-detection point for PR merge — wire here
   * so the checkpoint fires even when ReviewFeedbackTaskSpec gate filters done tasks.
   * Idempotent (sourceId dedup) so double-fire from both paths is safe.
   */
  readonly distillationCheckpoint?: import('../../infrastructure/distillation/DistillationCheckpoint.js').DistillationCheckpoint;
}

export class CiCdRouter {
  private readonly opts: CiCdRouterOptions;

  constructor(opts: CiCdRouterOptions) {
    this.opts = opts;
  }

  async route(poll: CiPollResult): Promise<CiRouteResult> {
    const { taskStore, log } = this.opts;
    const sk = prSubjectKey(poll.repoFullName, poll.prNumber);

    const task = await taskStore.getBySubject(sk);
    if (!task) {
      return { kind: 'skipped', reason: `No tracking task for ${poll.repoFullName}#${poll.prNumber}` };
    }

    const terminalPrState = poll.prState === 'merged' || poll.prState === 'closed' ? poll.prState : null;
    if (task.status === 'done') {
      if (terminalPrState && !task.automationState?.ci?.prState) {
        return this.closeLifecycle(poll, task, sk);
      }
      return {
        kind: 'skipped',
        reason: `Tracking task already processed for ${poll.repoFullName}#${poll.prNumber}`,
      };
    }

    if (task.automationState?.ci?.enabled === false) {
      if (!task.automationState.ci.skipNotified) {
        this.opts.notifySkip?.(task.threadId, 'ci_automation_disabled');
        await taskStore.patchAutomationState(task.id, { ci: { skipNotified: true } });
      }
      return { kind: 'skipped', reason: `CI tracking disabled for ${poll.repoFullName}#${poll.prNumber}` };
    }

    if (terminalPrState) {
      return this.closeLifecycle(poll, task, sk);
    }

    const intent = task.automationState?.intent ?? 'review';
    let externalReviewResult: ExternalReviewCoordinatorResult | undefined;
    if (intent === 'review' && task.ownerCatId) {
      try {
        externalReviewResult = await this.opts.externalReviewCoordinator?.recordCi(poll, {
          threadId: task.threadId,
          catId: task.ownerCatId,
          userId: task.userId ?? '',
          ...(task.automationState?.wakePolicy ? { wakePolicy: task.automationState.wakePolicy } : {}),
        });
      } catch (err) {
        log.warn(
          { err, repoFullName: poll.repoFullName, prNumber: poll.prNumber },
          '[F168] CI readiness update failed',
        );
      }
    }

    if (poll.aggregateBucket === 'pending') {
      await taskStore.patchAutomationState(task.id, {
        ci: { headSha: poll.headSha },
      });
      return { kind: 'skipped', reason: 'CI still pending' };
    }

    const fingerprint = `${poll.headSha}:${poll.aggregateBucket}`;
    if (poll.aggregateBucket === 'pass' && intent !== 'merge') {
      await taskStore.patchAutomationState(task.id, {
        ci: {
          headSha: poll.headSha,
          lastFingerprint: fingerprint,
          lastBucket: poll.aggregateBucket,
        },
      });
      if (externalReviewResult?.kind === 'notified') {
        return {
          kind: 'notified',
          threadId: externalReviewResult.threadId,
          catId: externalReviewResult.catId,
          messageId: externalReviewResult.messageId,
          bucket: 'pass',
          content: externalReviewResult.content,
          wakeKind: 'external_review_ready',
          headSha: externalReviewResult.headSha,
        };
      }
      if (task.automationState?.ci?.lastFingerprint === fingerprint) {
        return { kind: 'deduped', reason: `Already notified for ${fingerprint}` };
      }
      log.info(`[CiCdRouter] CI pass for ${poll.repoFullName}#${poll.prNumber} recorded silently (intent=${intent})`);
      return { kind: 'skipped', reason: `CI pass silent for review intent (${poll.repoFullName}#${poll.prNumber})` };
    }

    if (task.automationState?.ci?.lastFingerprint === fingerprint) {
      return { kind: 'deduped', reason: `Already notified for ${fingerprint}` };
    }

    return this.deliver(poll, task, fingerprint);
  }

  /**
   * PR reached terminal state (merged/closed).
   * Mark done first, then emit best-effort side effects and final owner-visible
   * lifecycle notification. Delivery failure degrades to the previous silent close.
   */
  private async closeLifecycle(poll: CiPollResult, task: TrackedTaskLike, sk: string): Promise<CiRouteResult> {
    const { taskStore, log } = this.opts;
    const prState = poll.prState as 'merged' | 'closed';

    // #320 KD-17: lifecycle close = mark task done (not delete)
    // F200 AC-D2.3: persist prState so signal detection can distinguish merged vs closed
    await taskStore.update(task.id, { status: 'done' });
    await taskStore.patchAutomationState(task.id, { ci: { prState } });
    log.info(`[CiCdRouter] PR ${poll.repoFullName}#${poll.prNumber} ${prState} — task marked done`);

    await this.emitTerminalSideEffects(poll, task, sk);

    try {
      const content = buildLifecycleMessageContent(poll, task.automationState?.trackingInstructions);
      const deliveryTarget = getConnectorDeliveryTarget(task);
      const source: ConnectorSource = {
        connector: 'github-ci',
        label: 'GitHub CI/CD',
        icon: 'github',
        url: `https://github.com/${poll.repoFullName}/pull/${poll.prNumber}`,
      };
      const delivered = await deliverConnectorMessage(this.opts.deliveryDeps, {
        ...deliveryTarget,
        content,
        source,
      });
      log.info(
        `[CiCdRouter] PR ${prState} -> lifecycle notification to ${deliveryTarget.catId} in thread ${deliveryTarget.threadId}`,
      );
      return {
        kind: 'lifecycle',
        threadId: deliveryTarget.threadId,
        catId: deliveryTarget.catId,
        messageId: delivered.messageId,
        prState,
        content,
      };
    } catch (err) {
      log.error(
        { err, repoFullName: poll.repoFullName, prNumber: poll.prNumber, threadId: task.threadId },
        '[CiCdRouter] lifecycle delivery failed — task already done, no retry (degrades to silent close)',
      );
      return { kind: 'skipped', reason: `PR ${prState} (lifecycle delivery failed)` };
    }
  }

  /** Best-effort side effects on terminal close: A1 signal, distillation checkpoint, community event. */
  private async emitTerminalSideEffects(poll: CiPollResult, task: TrackedTaskLike, sk: string): Promise<void> {
    const { log } = this.opts;

    // F192 Phase G: emit A1 world truth signal on merge only.
    // 'closed' = PR abandoned without merge — NOT a code revert.
    // Code reverts are separate git events (revert commits), not PR lifecycle.
    if (poll.prState === 'merged' && this.opts.onPrLifecycle) {
      try {
        const binding = await this.opts.taskStore.getManagedWorkBinding(task.id);
        await this.opts.onPrLifecycle({
          type: 'merge',
          ref: sk,
          outcome: 'success',
          threadId: task.threadId,
          attribution: binding ? { kind: 'managed_attributed', binding } : { kind: 'managed_unattributed' },
        });
      } catch (err) {
        log.warn(
          { err, repoFullName: poll.repoFullName, prNumber: poll.prNumber, threadId: task.threadId },
          '[CiCdRouter] onPrLifecycle callback failed (best-effort)',
        );
      }
    }

    // F208 AC-E2: distillation checkpoint on feat-phase-close (best-effort, merge only).
    // CiCdRouter is the canonical first-detection point for merge — checkpoint MUST fire here
    // because ReviewFeedbackTaskSpec gate filters done tasks and may miss.
    // sourceId dedup makes double-fire from ReviewFeedbackTaskSpec safe.
    if (poll.prState === 'merged' && this.opts.distillationCheckpoint) {
      try {
        // Extract featureId from trackingInstructions (prTitle not available here)
        const featureSource = task.automationState?.trackingInstructions ?? task.title ?? '';
        const featureMatch = featureSource.match(/\b[Ff](\d{2,4})\b/);
        const featureId = featureMatch ? `F${featureMatch[1]}` : undefined;
        if (featureId) {
          const phaseMatch = featureSource.match(/[Pp]hase\s+([A-Z])/i);
          await this.opts.distillationCheckpoint.onFeatPhaseClose({
            prNumber: poll.prNumber,
            repoFullName: poll.repoFullName,
            authorCatId: (task.ownerCatId ?? 'unknown') as string,
            threadId: task.threadId,
            featureId,
            phaseLabel: phaseMatch?.[1] ?? 'unknown',
          });
        }
      } catch {
        log.warn(
          `[CiCdRouter] distillation checkpoint (feat-phase-close) failed for ${poll.repoFullName}#${poll.prNumber}`,
        );
      }
    }

    // F168 Phase A P1-3: canonical community event emission.
    // This is the first reliable detection point for PR lifecycle.
    // sourceEventId = `lifecycle:${sk}:${prState}` — dedup-safe if ReviewFeedbackTaskSpec also fires.
    if (this.opts.eventLog) {
      try {
        const eventKind = poll.prState === 'merged' ? 'pr.merged' : 'pr.closed';
        const communityEvent = {
          sourceEventId: `lifecycle:${sk}:${poll.prState}`,
          subjectKey: sk,
          kind: eventKind as 'pr.merged' | 'pr.closed',
          classification: 'state-changing' as const,
          payload: {
            prState: poll.prState,
            repoFullName: poll.repoFullName,
            prNumber: poll.prNumber,
          },
          at: Date.now(),
        };
        const { appended } = await this.opts.eventLog.append(communityEvent);
        if (appended && this.opts.projector) {
          await this.opts.projector.apply(communityEvent);
        }
      } catch (err) {
        log.warn(
          { err, repoFullName: poll.repoFullName, prNumber: poll.prNumber, subjectKey: sk },
          '[CiCdRouter] event log append failed (best-effort, spec §Task6)',
        );
      }
    }
  }

  private async deliver(
    poll: CiPollResult,
    task: {
      id: string;
      threadId: string;
      ownerCatId: string | null;
      userId?: string;
      automationState?: {
        trackingInstructions?: string;
        intent?: 'review' | 'merge';
        ci?: { headSha?: string };
      };
    },
    fingerprint: string,
  ): Promise<CiRouteResult> {
    const { taskStore, log } = this.opts;
    const content = buildCiMessageContent(poll, task.automationState?.trackingInstructions);
    const deliveryTarget = getConnectorDeliveryTarget(task);

    const source: ConnectorSource = {
      connector: 'github-ci',
      label: 'GitHub CI/CD',
      icon: 'github',
      url: `https://github.com/${poll.repoFullName}/pull/${poll.prNumber}/checks`,
    };

    const deliveryDecision = buildDeliveryDecisionCueCarrier(poll, task, Date.now());
    const result = await deliverConnectorMessage(this.opts.deliveryDeps, {
      ...deliveryTarget,
      content,
      source,
      ...(deliveryDecision ? { extra: { memoryCue: { deliveryDecision } } } : {}),
    });

    // #320: Patch automationState.ci instead of patchCiState
    await taskStore.patchAutomationState(task.id, {
      ci: {
        headSha: poll.headSha,
        lastFingerprint: fingerprint,
        lastBucket: poll.aggregateBucket,
        lastNotifiedAt: Date.now(),
      },
    });

    log.info(
      `[CiCdRouter] CI ${poll.aggregateBucket} → ${task.ownerCatId} in thread ${task.threadId} (${fingerprint})`,
    );

    return {
      kind: 'notified',
      threadId: task.threadId,
      catId: deliveryTarget.catId,
      messageId: result.messageId,
      bucket: poll.aggregateBucket,
      content,
    };
  }
}
