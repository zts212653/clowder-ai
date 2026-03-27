import type { ConnectorSource } from '@cat-cafe/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { ConnectorDeliveryDeps } from './deliver-connector-message.js';
import { deliverConnectorMessage } from './deliver-connector-message.js';
import type { IPrTrackingStore } from './PrTrackingStore.js';

export interface ConflictSignal {
  readonly repoFullName: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly mergeState: string;
}

export type ConflictRouteResult =
  | { kind: 'notified'; threadId: string; catId: string; messageId: string; content: string }
  | { kind: 'deduped'; reason: string }
  | { kind: 'skipped'; reason: string };

export interface ConflictRouterOptions {
  readonly prTrackingStore: IPrTrackingStore;
  readonly deliveryDeps: ConnectorDeliveryDeps;
  readonly log: FastifyBaseLogger;
}

export class ConflictRouter {
  private readonly opts: ConflictRouterOptions;

  constructor(opts: ConflictRouterOptions) {
    this.opts = opts;
  }

  async route(signal: ConflictSignal): Promise<ConflictRouteResult> {
    const { prTrackingStore, log } = this.opts;
    const tracking = await prTrackingStore.get(signal.repoFullName, signal.prNumber);
    if (!tracking) {
      return { kind: 'skipped', reason: `No tracking entry for ${signal.repoFullName}#${signal.prNumber}` };
    }

    // UNKNOWN — GitHub hasn't computed yet, skip
    if (signal.mergeState === 'UNKNOWN') {
      return { kind: 'skipped', reason: 'mergeState UNKNOWN, will retry next poll' };
    }

    // KD-9: MERGEABLE → clear fingerprint so re-conflict with same SHA re-notifies
    if (signal.mergeState !== 'CONFLICTING') {
      if (tracking.lastConflictFingerprint) {
        await prTrackingStore.patchConflictState(signal.repoFullName, signal.prNumber, {
          lastConflictFingerprint: '',
          mergeState: signal.mergeState,
        });
        log.info(
          `[ConflictRouter] ${signal.repoFullName}#${signal.prNumber}: ${signal.mergeState} — fingerprint cleared`,
        );
      }
      return { kind: 'skipped', reason: `mergeState ${signal.mergeState}, not CONFLICTING` };
    }

    // Dedup: same headSha + CONFLICTING already notified
    const fingerprint = `${signal.headSha}:CONFLICTING`;
    if (tracking.lastConflictFingerprint === fingerprint) {
      return { kind: 'deduped', reason: `Already notified for ${fingerprint}` };
    }

    return this.deliver(signal, tracking, fingerprint);
  }

  private async deliver(
    signal: ConflictSignal,
    tracking: { threadId: string; catId: string; userId: string },
    fingerprint: string,
  ): Promise<ConflictRouteResult> {
    const { prTrackingStore, log } = this.opts;
    const content = buildConflictMessageContent(signal);

    const source: ConnectorSource = {
      connector: 'github-conflict',
      label: 'PR Conflict',
      icon: 'github',
      url: `https://github.com/${signal.repoFullName}/pull/${signal.prNumber}`,
    };

    const result = await deliverConnectorMessage(this.opts.deliveryDeps, {
      threadId: tracking.threadId,
      userId: tracking.userId,
      catId: tracking.catId,
      content,
      source,
    });

    await prTrackingStore.patchConflictState(signal.repoFullName, signal.prNumber, {
      lastConflictFingerprint: fingerprint,
      lastConflictNotifiedAt: Date.now(),
      mergeState: signal.mergeState,
    });

    log.info(`[ConflictRouter] CONFLICTING → ${tracking.catId} in thread ${tracking.threadId} (${fingerprint})`);

    return {
      kind: 'notified',
      threadId: tracking.threadId,
      catId: tracking.catId,
      messageId: result.messageId,
      content,
    };
  }
}

export function buildConflictMessageContent(signal: ConflictSignal): string {
  const lines: string[] = [
    '⚠️ **PR 冲突**',
    '',
    `PR #${signal.prNumber} (${signal.repoFullName})`,
    `Commit: \`${signal.headSha.slice(0, 7)}\``,
    '',
    '当前分支与 base 存在冲突，需要 rebase 或手动解决。',
    '',
    '---',
    '🔧 **自动处理**（KD-13: 全自动 + 事后通知）',
    `- 目标: ${signal.repoFullName}#${signal.prNumber}`,
    '- 操作: 在对应 worktree 执行 `git fetch origin main && git rebase origin/main`',
    '- rebase 成功: push 并通知铲屎官已自动解决',
    '- rebase 冲突: 评估复杂度 → 简单则尝试解决 → 复杂则通知铲屎官附冲突文件列表',
  ];
  return lines.join('\n');
}
