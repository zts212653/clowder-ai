/**
 * F133 + clowder-ai#320: CiCdRouter — route CI/CD poll results to the correct thread.
 *
 * #320: Reads from unified TaskStore instead of PrTrackingStore.
 */
import type { ConnectorSource } from '@cat-cafe/shared';
import { parsePrSubjectKey, prSubjectKey } from '@cat-cafe/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { ITaskStore } from '../../domains/cats/services/stores/ports/TaskStore.js';
import type { ConnectorDeliveryDeps } from './deliver-connector-message.js';
import { deliverConnectorMessage } from './deliver-connector-message.js';

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
      return { kind: 'skipped', reason: `CI tracking disabled for ${poll.repoFullName}#${poll.prNumber}` };
    }

    if (poll.prState === 'merged' || poll.prState === 'closed') {
      // #320 KD-17: lifecycle close = mark task done (not delete)
      await taskStore.update(task.id, { status: 'done' });
      log.info(`[CiCdRouter] PR ${poll.repoFullName}#${poll.prNumber} ${poll.prState} — task marked done`);
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
    task: { id: string; threadId: string; ownerCatId: string | null; userId?: string },
    fingerprint: string,
  ): Promise<CiRouteResult> {
    const { taskStore, log } = this.opts;
    const content = buildCiMessageContent(poll);

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

export function buildCiMessageContent(poll: CiPollResult): string {
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

  return lines.join('\n');
}
