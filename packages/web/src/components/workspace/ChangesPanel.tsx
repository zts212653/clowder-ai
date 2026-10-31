'use client';

import type { PullRequestChangesTarget } from '@cat-cafe/shared';
import { useLayoutEffect, useState } from 'react';
import { useShellPresentation } from '@/components/shell/shell-presentation';
import { ThreadNativeReviewSettingsContent } from '@/components/ThreadSidebar/ThreadNativeReviewSettings';
import type { CommitChangesTarget } from '../workbench/commit-changes-surface';
import { ChangesPanelV2 } from './ChangesPanelV2';
import { DiffViewer } from './DiffViewer';
import { FileIcon } from './FileIcons';
import { PullRequestChangesEmpty, PullRequestChangesStatus } from './PullRequestChangesStatus';
import { useChangesDiff } from './useChangesDiff';

const statusLabels: Record<string, { label: string; color: string }> = {
  M: { label: 'M', color: 'text-amber-400' },
  A: { label: 'A', color: 'text-green-400' },
  D: { label: 'D', color: 'text-conn-red-text' },
  R: { label: 'R', color: 'text-blue-400' },
  '?': { label: 'U', color: 'text-cafe-muted' },
  '??': { label: 'U', color: 'text-cafe-muted' },
};

function getStatusInfo(status: string) {
  return statusLabels[status] ?? { label: status, color: 'text-cafe-muted' };
}

interface ChangesPanelProps {
  worktreeId: string | null;
  basisPct: number;
  threadId?: string | null;
  onOpenFile?: (path: string) => void;
  pullRequestTarget?: PullRequestChangesTarget;
  chatSource?: boolean;
  commitTarget?: CommitChangesTarget;
  onBack?: () => void;
}

function ChangesPanelClassic({
  worktreeId,
  basisPct,
  threadId,
  pullRequestTarget,
  chatSource,
  commitTarget,
  onBack,
}: ChangesPanelProps) {
  const { data, loading, error, refresh, targetKey } = useChangesDiff(
    worktreeId,
    pullRequestTarget,
    chatSource,
    commitTarget,
  );
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  useLayoutEffect(() => setSelectedFile(null), [targetKey]);

  if (!worktreeId) {
    return <div className="p-4 text-center text-cafe-secondary text-xs">No worktree selected</div>;
  }

  return (
    <div className="flex flex-col min-h-0 flex-1">
      {pullRequestTarget && (
        <PullRequestChangesStatus target={pullRequestTarget} data={data} error={error} onBack={onBack} />
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
            {error === 'fetch_failed' ? 'Failed to fetch changes' : 'Network error'}
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
            {pullRequestTarget ? <PullRequestChangesEmpty /> : 'No uncommitted changes'}
          </div>
        )}
      </div>

      {/* Diff viewer */}
      <div className="flex-1 min-h-0 overflow-auto bg-[var(--ws-editor-deep)]">
        {data?.diff ? (
          <DiffViewer diff={data.diff} filePath={selectedFile ?? undefined} />
        ) : (
          <div className="p-4 text-center text-cafe-secondary text-xs">
            {loading ? 'Loading...' : 'Select a file to view diff'}
          </div>
        )}
      </div>
    </div>
  );
}

export function ChangesPanel(props: ChangesPanelProps) {
  const presentation = useShellPresentation();
  return presentation === 'v2' ? <ChangesPanelV2 {...props} /> : <ChangesPanelClassic {...props} />;
}
