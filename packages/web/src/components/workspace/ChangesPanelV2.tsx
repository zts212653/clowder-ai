'use client';

import type { PullRequestChangesTarget } from '@cat-cafe/shared';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useShellCopy } from '@/components/shell/shell-copy';
import { ThreadNativeReviewSettingsContent } from '@/components/ThreadSidebar/ThreadNativeReviewSettings';
import { useWorkspaceSurfaceVisibility } from '@/components/workbench/WorkspaceSurfaceVisibility';
import type { CommitChangesTarget } from '../workbench/commit-changes-surface';
import { codeToolsCopy } from './code-tools.shell-copy';
import { DiffViewer, parseUnifiedDiff } from './DiffViewer';
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

interface ChangesPanelV2Props {
  worktreeId: string | null;
  basisPct: number;
  threadId?: string | null;
  onOpenFile?: (path: string) => void;
  pullRequestTarget?: PullRequestChangesTarget;
  chatSource?: boolean;
  commitTarget?: CommitChangesTarget;
  onBack?: () => void;
}

/**
 * F322 v2（北极星 §1.13 代码 4）：请 Codex 审查改动、每个文件的状态字母和增删行数、
 * 合并/并排两种看法、每文件一块 diff。数据沿原 /api/workspace/diff 只读接口。
 * 「打开文件」走 C 的 onOpenFile 接缝（coord-e6d806a7 冻结合同）：有 callback 才显示，
 * 没有就不放假动作；diff 模式、文件选择/滚动、classic 保持原样。
 */
export function ChangesPanelV2({
  worktreeId,
  basisPct,
  threadId,
  onOpenFile,
  pullRequestTarget,
  chatSource,
  commitTarget,
  onBack,
}: ChangesPanelV2Props) {
  const copy = useShellCopy(codeToolsCopy).changes;
  const { data, loading, error, refresh, targetKey } = useChangesDiff(
    worktreeId,
    pullRequestTarget,
    chatSource,
    commitTarget,
  );
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const visible = useWorkspaceSurfaceVisibility();
  const diffViewport = useRef<HTMLDivElement>(null);
  const reading = useRef({ targetKey, top: 0 });
  useLayoutEffect(() => {
    if (reading.current.targetKey !== targetKey) {
      reading.current = { targetKey, top: 0 };
      setSelectedFile(null);
    }
    // The owner remains mounted, but Chromium can clamp a hidden viewport to zero.
    if (visible && diffViewport.current) diffViewport.current.scrollTop = reading.current.top;
  }, [visible, targetKey]);

  const lineStats = useMemo(() => {
    const stats = new Map<string, { added: number; deleted: number }>();
    if (!data?.diff) return stats;
    for (const file of parseUnifiedDiff(data.diff)) {
      let added = 0;
      let deleted = 0;
      for (const hunk of file.hunks) {
        for (const line of hunk.lines) {
          if (line.type === 'add') added++;
          else if (line.type === 'remove') deleted++;
        }
      }
      stats.set(file.path, { added, deleted });
    }
    return stats;
  }, [data?.diff]);

  if (!worktreeId) {
    return <div className="p-4 text-center text-cafe-secondary text-xs">{copy.noWorktree}</div>;
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
            {copy.reviewSummary}
          </summary>
          <ThreadNativeReviewSettingsContent threadId={threadId} />
        </details>
      )}

      <div
        className="flex-shrink-0 overflow-y-auto border-b border-cafe-subtle/40"
        style={{ maxHeight: `${basisPct}%` }}
      >
        <div className="px-3 py-1.5 flex items-center justify-between sticky top-0 bg-cafe-white/95 backdrop-blur-sm">
          <span className="text-micro text-cafe-interactive/50 font-semibold tracking-wider">
            {data ? copy.changedCount(data.changedFiles.length) : copy.title}
          </span>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            className="text-micro text-cafe-interactive/40 hover:text-cafe-interactive transition-colors disabled:opacity-50"
            title={copy.refresh}
          >
            {loading ? '…' : '↻'}
          </button>
        </div>
        {error && !pullRequestTarget && (
          <div className="px-3 py-1.5 text-micro text-conn-red-text">
            {error === 'fetch_failed' ? copy.fetchFailed : copy.networkError}
          </div>
        )}
        {data?.changedFiles.map((f) => {
          const info = getStatusInfo(f.status);
          const stats = lineStats.get(f.path);
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
              {stats && (
                <span className="text-micro font-mono shrink-0">
                  <span className="text-conn-green-text">+{stats.added}</span>{' '}
                  <span className="text-conn-red-text">−{stats.deleted}</span>
                </span>
              )}
              <span className="text-micro text-cafe-muted truncate ml-auto">
                {f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''}
              </span>
            </button>
          );
        })}
        {data && data.changedFiles.length === 0 && (
          <div className="px-3 py-4 text-center text-cafe-muted text-xs">
            {pullRequestTarget ? <PullRequestChangesEmpty /> : copy.noChanges}
          </div>
        )}
      </div>

      <div
        ref={diffViewport}
        className="flex-1 min-h-0 overflow-auto bg-[var(--ws-editor-deep)]"
        onScroll={(event) => {
          if (visible) reading.current = { targetKey, top: event.currentTarget.scrollTop };
        }}
      >
        {data?.diff ? (
          <DiffViewer
            diff={data.diff}
            filePath={selectedFile ?? undefined}
            labels={{ unified: copy.diffUnified, sideBySide: copy.diffSideBySide, filesChanged: copy.changedCount }}
            onOpenFile={
              onOpenFile
                ? (path) => {
                    // Capture at the original action before the host hides this owner,
                    // including a last native scroll whose event has not fired yet.
                    if (diffViewport.current) reading.current = { targetKey, top: diffViewport.current.scrollTop };
                    onOpenFile(path);
                  }
                : undefined
            }
            openFileLabel={copy.openFile}
          />
        ) : (
          <div className="p-4 text-center text-cafe-secondary text-xs">{loading ? copy.loading : copy.selectFile}</div>
        )}
      </div>
    </div>
  );
}
