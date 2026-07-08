/**
 * Message content builders for CI/CD tracking notifications.
 * Extracted from CiCdRouter.ts so lifecycle delivery can stay small and reusable.
 */
import type { CiPollResult } from './CiCdRouter.js';

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

/** Terminal lifecycle (merged/closed) notification. */
export function buildLifecycleMessageContent(
  poll: Pick<CiPollResult, 'repoFullName' | 'prNumber' | 'prState'>,
  trackingInstructions?: string,
): string {
  const merged = poll.prState === 'merged';
  const headline = merged ? '🎉 **PR 已 merge**' : '🚪 **PR 已关闭（未合并）**';

  const lines: string[] = [headline, '', `PR #${poll.prNumber} (${poll.repoFullName})`];

  lines.push(
    '',
    merged
      ? '请执行 post-merge 收尾（验证 main、更新任务状态、清理分支/worktree）。'
      : '该 PR 未合并即关闭，请确认是否需要跟进（重开、改道或收尾归档）。',
  );

  // F202 Phase 2C (AC-C2): append user-provided tracking instructions
  if (trackingInstructions) {
    lines.push('', '📌 **Tracking Instructions**', trackingInstructions);
  }

  return lines.join('\n');
}
