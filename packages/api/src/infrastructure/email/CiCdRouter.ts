/**
 * F133 + clowder-ai#320: CiCdRouter — route CI/CD poll results to the correct thread.
 *
 * #320: Reads from unified TaskStore instead of PrTrackingStore.
 */
import type { ConnectorSource } from '@cat-cafe/shared';
import { parsePrSubjectKey, prSubjectKey } from '@cat-cafe/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { ITaskStore } from '../../domains/cats/services/stores/ports/TaskStore.js';
import type { ICommunityEventLog } from '../../domains/community/CommunityEventLog.js';
import type { ConnectorDeliveryDeps } from './deliver-connector-message.js';
import { deliverConnectorMessage } from './deliver-connector-message.js';

/** Minimal projector interface for optional DI — avoids importing concrete class. */
interface ICommunityProjectorMin {
  apply(event: Parameters<ICommunityEventLog['append']>[0]): Promise<void>;
}

export type CiBucket = 'pass' | 'fail' | 'pending';

export interface CiCheckDetail {
  readonly name: string;
  readonly bucket: CiBucket;
  readonly link?: string;
  readonly workflow?: string;
  readonly description?: string;
}

export interface CiPollResult {
  readonly repoFullName: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly prState: 'open' | 'merged' | 'closed';
  readonly aggregateBucket: CiBucket;
  readonly checks: readonly CiCheckDetail[];
}

export type CiRouteResult =
  | { kind: 'notified'; threadId: string; catId: string; messageId: string; bucket: CiBucket; content: string }
  | { kind: 'deduped'; reason: string }
  | { kind: 'skipped'; reason: string };

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
  }) => void;
  /**
   * F168 Phase A (P1-3 fix): canonical PR lifecycle event emission point.
   * CiCdRouter is first to detect merged/closed; ReviewFeedbackTaskSpec may race.
   * sourceEventId dedup ensures double-fire is safe.
   */
  readonly eventLog?: ICommunityEventLog;
  /** Optional projector to apply the emitted event immediately after append. */
  readonly projector?: ICommunityProjectorMin;
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

    if (task.automationState?.ci?.enabled === false) {
      if (!task.automationState.ci.skipNotified) {
        this.opts.notifySkip?.(task.threadId, 'ci_automation_disabled');
        await taskStore.patchAutomationState(task.id, { ci: { skipNotified: true } });
      }
      return { kind: 'skipped', reason: `CI tracking disabled for ${poll.repoFullName}#${poll.prNumber}` };
    }

    if (poll.prState === 'merged' || poll.prState === 'closed') {
      // #320 KD-17: lifecycle close = mark task done (not delete)
      // F200 AC-D2.3: persist prState so signal detection can distinguish merged vs closed
      await taskStore.update(task.id, { status: 'done' });
      await taskStore.patchAutomationState(task.id, { ci: { prState: poll.prState } });
      log.info(`[CiCdRouter] PR ${poll.repoFullName}#${poll.prNumber} ${poll.prState} — task marked done`);

      // F192 Phase G: emit A1 world truth signal on merge only.
      // 'closed' = PR abandoned without merge — NOT a code revert.
      // Code reverts are separate git events (revert commits), not PR lifecycle.
      if (poll.prState === 'merged' && this.opts.onPrLifecycle) {
        try {
          this.opts.onPrLifecycle({
            type: 'merge',
            ref: `PR#${poll.prNumber}`,
            outcome: 'success',
            threadId: task.threadId,
          });
        } catch {
          // Best-effort: don't break CI/CD routing
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
        } catch {
          // Best-effort: event log failure MUST NOT block CI/CD routing (spec §Task6)
        }
      }

      return { kind: 'skipped', reason: `PR ${poll.prState}` };
    }

    if (poll.aggregateBucket === 'pending') {
      await taskStore.patchAutomationState(task.id, {
        ci: { headSha: poll.headSha },
      });
      return { kind: 'skipped', reason: 'CI still pending' };
    }

    const fingerprint = `${poll.headSha}:${poll.aggregateBucket}`;
    if (task.automationState?.ci?.lastFingerprint === fingerprint) {
      return { kind: 'deduped', reason: `Already notified for ${fingerprint}` };
    }

    return this.deliver(poll, task, fingerprint);
  }

  private async deliver(
    poll: CiPollResult,
    task: {
      id: string;
      threadId: string;
      ownerCatId: string | null;
      userId?: string;
      automationState?: { trackingInstructions?: string };
    },
    fingerprint: string,
  ): Promise<CiRouteResult> {
    const { taskStore, log } = this.opts;
    const content = buildCiMessageContent(poll, task.automationState?.trackingInstructions);

    const source: ConnectorSource = {
      connector: 'github-ci',
      label: 'GitHub CI/CD',
      icon: 'github',
      url: `https://github.com/${poll.repoFullName}/pull/${poll.prNumber}/checks`,
    };

    const result = await deliverConnectorMessage(this.opts.deliveryDeps, {
      threadId: task.threadId,
      userId: task.userId ?? '',
      catId: task.ownerCatId ?? '',
      content,
      source,
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
      catId: task.ownerCatId ?? '',
      messageId: result.messageId,
      bucket: poll.aggregateBucket,
      content,
    };
  }
}

export function buildCiMessageContent(poll: CiPollResult, trackingInstructions?: string): string {
  const bucketEmoji = poll.aggregateBucket === 'pass' ? '✅' : '❌';
  const bucketLabel = poll.aggregateBucket === 'pass' ? 'CI 通过' : 'CI 失败';

  const lines: string[] = [
    `${bucketEmoji} **${bucketLabel}**`,
    '',
    `PR #${poll.prNumber} (${poll.repoFullName})`,
    `Commit: \`${poll.headSha.slice(0, 7)}\``,
  ];

  const failedChecks = poll.checks.filter((c) => c.bucket === 'fail');
  if (failedChecks.length > 0) {
    lines.push('', `--- 失败的检查 (${failedChecks.length}) ---`);
    for (const check of failedChecks) {
      const linkPart = check.link ? ` [查看](${check.link})` : '';
      const descPart = check.description ? ` — ${check.description.slice(0, 120)}` : '';
      lines.push(`❌ **${check.name}**${descPart}${linkPart}`);
    }
  }

  if (poll.aggregateBucket === 'fail') {
    lines.push('', '请检查 CI 失败原因并修复。');
  }

  // F202 Phase 2C (AC-C2): append user-provided tracking instructions
  if (trackingInstructions) {
    lines.push('', '📌 **Tracking Instructions**', trackingInstructions);
  }

  return lines.join('\n');
}
