import type { ConnectorSource } from '@cat-cafe/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { ConnectorDeliveryDeps } from './deliver-connector-message.js';
import { deliverConnectorMessage } from './deliver-connector-message.js';
import type { IPrTrackingStore, PrTrackingEntry } from './PrTrackingStore.js';

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
  readonly prTrackingStore: IPrTrackingStore;
  readonly deliveryDeps: ConnectorDeliveryDeps;
  readonly log: FastifyBaseLogger;
}

export class CiCdRouter {
  private readonly opts: CiCdRouterOptions;

  constructor(opts: CiCdRouterOptions) {
    this.opts = opts;
  }

  async route(poll: CiPollResult): Promise<CiRouteResult> {
    const { prTrackingStore, log } = this.opts;

    const tracking = await prTrackingStore.get(poll.repoFullName, poll.prNumber);
    if (!tracking) {
      return { kind: 'skipped', reason: `No tracking entry for ${poll.repoFullName}#${poll.prNumber}` };
    }

    if (tracking.ciTrackingEnabled === false) {
      return { kind: 'skipped', reason: `CI tracking disabled for ${poll.repoFullName}#${poll.prNumber}` };
    }

    if (poll.prState === 'merged' || poll.prState === 'closed') {
      await prTrackingStore.remove(poll.repoFullName, poll.prNumber);
      log.info(`[CiCdRouter] PR ${poll.repoFullName}#${poll.prNumber} ${poll.prState} — removed from tracking`);
      return { kind: 'skipped', reason: `PR ${poll.prState}` };
    }

    if (poll.aggregateBucket === 'pending') {
      await prTrackingStore.patchCiState(poll.repoFullName, poll.prNumber, { headSha: poll.headSha });
      return { kind: 'skipped', reason: 'CI still pending' };
    }

    const fingerprint = `${poll.headSha}:${poll.aggregateBucket}`;
    if (tracking.lastCiFingerprint === fingerprint) {
      return { kind: 'deduped', reason: `Already notified for ${fingerprint}` };
    }

    return this.deliver(poll, tracking, fingerprint);
  }

  private async deliver(poll: CiPollResult, tracking: PrTrackingEntry, fingerprint: string): Promise<CiRouteResult> {
    const { prTrackingStore, log } = this.opts;
    const content = buildCiMessageContent(poll);

    const source: ConnectorSource = {
      connector: 'github-ci',
      label: 'GitHub CI/CD',
      icon: 'github',
      url: `https://github.com/${poll.repoFullName}/pull/${poll.prNumber}/checks`,
    };

    const result = await deliverConnectorMessage(this.opts.deliveryDeps, {
      threadId: tracking.threadId,
      userId: tracking.userId,
      catId: tracking.catId,
      content,
      source,
    });

    await prTrackingStore.patchCiState(poll.repoFullName, poll.prNumber, {
      headSha: poll.headSha,
      lastCiFingerprint: fingerprint,
      lastCiBucket: poll.aggregateBucket,
      lastCiNotifiedAt: Date.now(),
    });

    log.info(
      `[CiCdRouter] CI ${poll.aggregateBucket} → ${tracking.catId} in thread ${tracking.threadId} (${fingerprint})`,
    );

    return {
      kind: 'notified',
      threadId: tracking.threadId,
      catId: tracking.catId,
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
