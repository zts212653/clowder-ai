'use client';

import type { PullRequestChangesTarget } from '@cat-cafe/shared';
import { useLayoutEffect, useState } from 'react';
import { useShellPresentation } from '@/components/shell/shell-presentation';
import { ThreadNativeReviewSettingsContent } from '@/components/ThreadSidebar/ThreadNativeReviewSettings';
import { isGitWorktreeRequired } from '@/utils/git-response-error';
import type { CommitChangesTarget } from '../workbench/commit-changes-surface';
import { ChangesDiffPlaceholder } from './ChangesDiffPlaceholder';
import { ChangesPanelV2 } from './ChangesPanelV2';
import { DiffViewer } from './DiffViewer';
import { FileIcon } from './FileIcons';
import { getStatusInfo } from './git-file-status';
import { PullRequestChangesEmpty, PullRequestChangesStatus } from './PullRequestChangesStatus';
import { useChangesDiff } from './useChangesDiff';

interface ChangesPanelProps {
  worktreeId: string | null;
  basisPct: number;
  threadId?: string | null;
  onOpenFile?: (path: string) => void;
  pullRequestTarget?: PullRequestChangesTarget;
  commitTarget?: CommitChangesTarget;
  onBack?: () => void;
}

function ChangesPanelClassic({
  worktreeId,
  basisPct,
  threadId,
  pullRequestTarget,
  commitTarget,
  onBack,
}: ChangesPanelProps) {
  const { data, loading, error, refresh, targetKey } = useChangesDiff(worktreeId, pullRequestTarget, commitTarget);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  useLayoutEffect(() => setSelectedFile(null), [targetKey]);

  if (!worktreeId) {
    return <div className="p-4 text-center text-cafe-secondary text-xs">No worktree selected</div>;
  }

  return (
    <div className="flex flex-col min-h-0 flex-1">
      {pullRequestTarget && (
        <PullRequestChangesStatus
          target={pullRequestTarget}
          data={data}
          error={error}
          onBack={onBack}
          onRetry={() => void refresh()}
        />
      )}
      {threadId && !pullRequestTarget && (
        <details
          className="flex-shrink-0 border-b border-cafe-subtle/40 bg-cafe-surface/40"
          data-testid="native-review-workspace-strip"
        >
          <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-cafe-black">
            让 Codex 检查当前改动
          </summary>
          <ThreadNativeReviewSettingsContent threadId={threadId} />
        </details>
      )}
      {/* Changed files list */}
      <div
        className="flex-shrink-0 overflow-y-auto border-b border-cafe-subtle/40"
        style={{ maxHeight: `${basisPct}%` }}
      >
        <div className="px-3 py-1.5 flex items-center justify-between sticky top-0 bg-cafe-white/95 backdrop-blur-sm">
          <span className="text-micro text-cafe-interactive/50 font-semibold uppercase tracking-wider">
            {data ? `${data.changedFiles.length} changed` : 'Changes'}
          </span>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            className="text-micro text-cafe-interactive/40 hover:text-cafe-interactive transition-colors disabled:opacity-50"
            title="Refresh"
          >
            {loading ? '...' : '↻'}
          </button>
        </div>
        {error && !pullRequestTarget && (
          <div className="px-3 py-1.5 text-micro text-conn-red-text">
            {isGitWorktreeRequired(error)
              ? 'This is a bare Git repository; this view requires a working tree'
              : error === 'fetch_failed'
                ? 'Failed to fetch changes'
                : 'Network error'}
          </div>
        )}
        {data?.changedFiles.map((f) => {
          const info = getStatusInfo(f.status);
          return (
            <button
              key={f.path}
              type="button"
              onClick={() => setSelectedFile(selectedFile === f.path ? null : f.path)}
              className={`w-full text-left px-3 py-1 flex items-center gap-1.5 hover:bg-cafe-surface/60 transition-colors ${
                selectedFile === f.path ? 'bg-cafe-surface/80' : ''
              }`}
            >
              <span className={`text-micro font-mono font-bold w-3 ${info.color}`}>{info.label}</span>
              <FileIcon name={f.path} />
              <span className="text-xs text-cafe-black truncate">{f.path.split('/').pop()}</span>
              <span className="text-micro text-cafe-muted truncate ml-auto">
                {f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''}
              </span>
            </button>
          );
        })}
        {data && data.changedFiles.length === 0 && (
          <div className="px-3 py-4 text-center text-cafe-muted text-xs">
            {data.isGitRepository === false ? (
              'Not a Git repository'
            ) : pullRequestTarget ? (
              <PullRequestChangesEmpty />
            ) : (
              'No uncommitted changes'
            )}
          </div>
        )}
      </div>

      {/* Diff viewer */}
      <div className="flex-1 min-h-0 overflow-auto bg-[var(--ws-editor-deep)]">
        {data?.diff ? (
          <DiffViewer diff={data.diff} filePath={selectedFile ?? undefined} />
        ) : (
          <ChangesDiffPlaceholder
            loading={loading}
            failed={Boolean(pullRequestTarget && error)}
            loadingLabel="Loading..."
            selectFileLabel="Select a file to view diff"
          />
        )}
      </div>
    </div>
  );
}

export function ChangesPanel(props: ChangesPanelProps) {
  const presentation = useShellPresentation();
  return presentation === 'v2' ? <ChangesPanelV2 {...props} /> : <ChangesPanelClassic {...props} />;
}
