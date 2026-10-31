'use client';

import type { PullRequestChangesTarget } from '@cat-cafe/shared';
import { defineShellCopy, useShellCopy } from '@/components/shell/shell-copy';
import type { ChangesDiffData, ChangesDiffError } from './useChangesDiff';

const copy = defineShellCopy(
  {
    zh: {
      back: '返回来源',
      version: (sha: string) => `读取版本 ${sha.slice(0, 8)}`,
      empty: '这次 PR 读取没有可显示的文件',
      partial: '仅显示部分变更',
      file_limit: '文件清单未完整返回',
      missing_patch: '部分文件没有可显示的 diff',
      filtered_paths: '敏感路径已隐藏',
      patch_limit: '部分 diff 超出显示范围',
      authentication_required: '请先登录 GitHub 后重试。',
      identity_required: '请从当前登录的页面重试。',
      permission_denied: '当前 GitHub 身份无权读取这个 PR。',
      rate_limited: 'GitHub 请求受限，请稍后重试。',
      not_found: '这个 PR 不存在或当前身份无法访问。',
      root_unavailable: '来源工作区已不可用，请重新选择工作区。',
      repository_mismatch: '来源工作区与这个 PR 的仓库不匹配。',
      invalid_target: '这个 PR 来源无效。',
      unavailable: '暂时无法读取这个 PR，请重试。',
      network: '网络连接失败，请重试。',
      fetch_failed: '暂时无法读取这个 PR，请重试。',
    },
    en: {
      back: 'Back to source',
      version: (sha: string) => `Read revision ${sha.slice(0, 8)}`,
      empty: 'No displayable files in this PR read',
      partial: 'Showing partial changes',
      file_limit: 'The file list is incomplete',
      missing_patch: 'Some files have no available diff',
      filtered_paths: 'Sensitive paths are hidden',
      patch_limit: 'Some diffs exceed the display limit',
      authentication_required: 'Sign in to GitHub and retry.',
      identity_required: 'Retry from your signed-in page.',
      permission_denied: 'Your GitHub account cannot read this PR.',
      rate_limited: 'GitHub rate limit reached. Retry later.',
      not_found: 'This PR is missing or inaccessible to your account.',
      root_unavailable: 'The source workspace is unavailable. Select it again.',
      repository_mismatch: 'The source workspace belongs to a different repository.',
      invalid_target: 'This PR source is invalid.',
      unavailable: 'This PR is temporarily unavailable. Retry.',
      network: 'Connection failed. Retry.',
      fetch_failed: 'This PR is temporarily unavailable. Retry.',
    },
  },
  { samples: { version: [['a'.repeat(40)]] } },
);

export function PullRequestChangesEmpty() {
  return <>{useShellCopy(copy).empty}</>;
}

export function PullRequestChangesStatus({
  target,
  data,
  error,
  onBack,
}: {
  target: PullRequestChangesTarget;
  data: ChangesDiffData | null;
  error: ChangesDiffError | null;
  onBack?: () => void;
}) {
  const t = useShellCopy(copy);
  return (
    <div
      className="shrink-0 border-b border-cafe-subtle px-3 py-2 text-xs text-cafe-secondary"
      data-testid="pull-request-changes-status"
    >
      <div className="flex items-center justify-between gap-2">
        <span>
          {target.repoFullName}#{target.prNumber}
        </span>
        {onBack && (
          <button type="button" data-testid="changes-origin-back" onClick={onBack} className="text-cafe-accent">
            {t.back}
          </button>
        )}
      </div>
      {data?.comparison && <p className="mt-1 text-cafe-muted">{t.version(data.comparison.headSha)}</p>}
      {data?.completeness === 'partial' && (
        <p className="mt-1" role="status">
          {t.partial} · {data.omissions?.map((reason) => t[reason]).join(' · ')}
        </p>
      )}
      {error && (
        <p className="mt-1 text-conn-red-text" role="alert">
          {t[error]}
        </p>
      )}
    </div>
  );
}
