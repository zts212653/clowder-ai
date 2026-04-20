/**
 * F140 + clowder-ai#320: ConflictRouter — route merge conflict signals to the correct thread.
 *
 * #320: Reads from unified TaskStore instead of PrTrackingStore.
 */
import type { ConnectorSource } from '@cat-cafe/shared';
import { prSubjectKey } from '@cat-cafe/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { ITaskStore } from '../../domains/cats/services/stores/ports/TaskStore.js';
import type { ConnectorDeliveryDeps } from './deliver-connector-message.js';
import { deliverConnectorMessage } from './deliver-connector-message.js';

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
  readonly taskStore: ITaskStore;
  readonly deliveryDeps: ConnectorDeliveryDeps;
  readonly log: FastifyBaseLogger;
}

export class ConflictRouter {
  private readonly opts: ConflictRouterOptions;

  constructor(opts: ConflictRouterOptions) {
    this.opts = opts;
  }

  async route(signal: ConflictSignal): Promise<ConflictRouteResult> {
    const { taskStore, log } = this.opts;
    const sk = prSubjectKey(signal.repoFullName, signal.prNumber);

    const task = await taskStore.getBySubject(sk);
    if (!task) {
      return { kind: 'skipped', reason: `No tracking task for ${signal.repoFullName}#${signal.prNumber}` };
    }

    if (signal.mergeState === 'UNKNOWN') {
      return { kind: 'skipped', reason: 'mergeState UNKNOWN, will retry next poll' };
    }

    // KD-9: MERGEABLE → clear fingerprint so re-conflict with same SHA re-notifies
    if (signal.mergeState !== 'CONFLICTING') {
      if (task.automationState?.conflict?.lastFingerprint) {
        await taskStore.patchAutomationState(task.id, {
          conflict: { lastFingerprint: '', mergeState: signal.mergeState },
        });
        log.info(
          `[ConflictRouter] ${signal.repoFullName}#${signal.prNumber}: ${signal.mergeState} — fingerprint cleared`,
        );
      }
      return { kind: 'skipped', reason: `mergeState ${signal.mergeState}, not CONFLICTING` };
    }

    const fingerprint = `${signal.headSha}:CONFLICTING`;
    if (task.automationState?.conflict?.lastFingerprint === fingerprint) {
      return { kind: 'deduped', reason: `Already notified for ${fingerprint}` };
    }

    return this.deliver(signal, task, fingerprint);
  }

  private async deliver(
    signal: ConflictSignal,
    task: { id: string; threadId: string; ownerCatId: string | null; userId?: string },
    fingerprint: string,
  ): Promise<ConflictRouteResult> {
    const { taskStore, log } = this.opts;
    const content = buildConflictMessageContent(signal);

    const source: ConnectorSource = {
      connector: 'github-conflict',
      label: 'PR Conflict',
      icon: 'github',
      url: `https://github.com/${signal.repoFullName}/pull/${signal.prNumber}`,
    };

    const result = await deliverConnectorMessage(this.opts.deliveryDeps, {
      threadId: task.threadId,
      userId: task.userId ?? '',
      catId: task.ownerCatId ?? '',
      content,
      source,
    });

    // #320: Patch automationState.conflict instead of patchConflictState
    await taskStore.patchAutomationState(task.id, {
      conflict: {
        lastFingerprint: fingerprint,
        lastNotifiedAt: Date.now(),
        mergeState: signal.mergeState,
      },
    });

    log.info(`[ConflictRouter] CONFLICTING → ${task.ownerCatId} in thread ${task.threadId} (${fingerprint})`);

    return {
      kind: 'notified',
      threadId: task.threadId,
      catId: task.ownerCatId ?? '',
      messageId: result.messageId,
      content,
    };
  }
}

export function buildConflictMessageContent(signal: ConflictSignal): string {
  const lines: string[] = [
    '\u26a0\ufe0f **PR 冲突**',
    '',
    `PR #${signal.prNumber} (${signal.repoFullName})`,
    `Commit: \`${signal.headSha.slice(0, 7)}\``,
    '',
    '当前分支与 base 存在冲突，需要 rebase 或手动解决。',
    '',
    '---',
    '\ud83d\udd27 **自动处理**（KD-13: 全自动 + 事后通知）',
    `- 目标: ${signal.repoFullName}#${signal.prNumber}`,
    '- 操作: 在对应 worktree 执行 `git fetch origin main && git rebase origin/main`',
    '- rebase 成功: push 并通知铲屎官已自动解决',
    '- rebase 冲突: 评估复杂度 → 简单则尝试解决 → 复杂则通知铲屎官附冲突文件列表',
  ];
  return lines.join('\n');
}
