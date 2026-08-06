/**
 * Message content builders for CI/CD tracking notifications.
 * Extracted from CiCdRouter.ts so lifecycle delivery can stay small and reusable.
 */
import type { CiPollResult } from './CiCdRouter.js';

export function buildCiMessageContent(poll: CiPollResult, _legacyInstructions?: string): string {
  const failedChecks = poll.checks.filter((c) => c.bucket === 'fail');
  return [
    `🔔 **PR wait candidate** — ${poll.repoFullName}#${poll.prNumber}`,
    '',
    `- CI ${poll.aggregateBucket} (${failedChecks.length} blockers)`,
    `- HEAD ${poll.headSha.slice(0, 7)}`,
    '',
    'The typed wait predicate decides whether this becomes an owner wake.',
  ].join('\n');
}

/** Terminal lifecycle (merged/closed) notification. */
export function buildLifecycleMessageContent(
  poll: Pick<CiPollResult, 'repoFullName' | 'prNumber' | 'prState'>,
  _legacyInstructions?: string,
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

  if (merged) {
    lines.push(
      '',
      '若 PR 触及 runtime 加载面，请分开报告 main 与 live runtime：默认记录 `live=dormant`（未加载/未生效），不得自动同步或重启；只有co-creator显式授权后，才从 main 运行 `pnpm start` 完成 sync+build+restart，并以新进程或 fresh invocation 验证生效。',
    );
  }

  return lines.join('\n');
}
