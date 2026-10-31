'use client';

import { useEffect, useState } from 'react';
import { ExpandableProse } from '@/components/content-overflow';
import { useShellCopy } from '@/components/shell/shell-copy';
import { isRowPrimaryActionTarget } from '@/utils/row-primary-action';
import type { GitHealthResult } from '../../hooks/useGitHealth';
import { useGitHealth } from '../../hooks/useGitHealth';
import type { GitCommit } from '../../hooks/useGitPanel';
import { useGitPanel } from '../../hooks/useGitPanel';
import { type CodeToolsCopy, codeToolsCopy } from './code-tools.shell-copy';

type GitCopy = CodeToolsCopy['git'];

/** Returns null when the source date is missing or unparseable — never render "Invalid Date". */
function formatRelativeDate(isoDate: string, copy: GitCopy): string | null {
  const time = new Date(isoDate).getTime();
  if (!isoDate || Number.isNaN(time)) return null;
  const diff = Date.now() - time;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return copy.justNow;
  if (mins < 60) return copy.minutesAgo(mins);
  const hours = Math.floor(mins / 60);
  if (hours < 24) return copy.hoursAgo(hours);
  const days = Math.floor(hours / 24);
  if (days < 30) return copy.daysAgo(days);
  return new Date(isoDate).toLocaleDateString();
}

function StatusBadge({ status, variant }: { status: string; variant: 'staged' | 'unstaged' | 'untracked' }) {
  const colors = {
    staged: 'bg-conn-green-bg text-conn-green-text',
    unstaged: 'bg-conn-amber-bg text-conn-amber-text',
    untracked: 'bg-cafe-surface-elevated text-cafe-secondary',
  };
  return (
    <span className={`inline-block px-1 py-0.5 rounded text-micro font-mono font-bold ${colors[variant]}`}>
      {status}
    </span>
  );
}

function Section({
  title,
  collapsed,
  onToggle,
  children,
}: {
  title: string;
  collapsed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-cafe-subtle/40">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-cafe-surface-sunken/20"
      >
        <span className="text-micro font-semibold text-cafe-interactive/60 tracking-wider">{title}</span>
        <span className="text-micro text-cafe-interactive/40">{collapsed ? '▸' : '▾'}</span>
      </button>
      {!collapsed && <div className="px-3 pb-2">{children}</div>}
    </div>
  );
}

function StatusGroup({
  title,
  items,
  variant,
  statusGroup,
}: {
  title: string;
  items: Array<{ status: string; path: string }>;
  variant: 'staged' | 'unstaged' | 'untracked';
  statusGroup: (label: string, count: number) => string;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mb-1.5">
      <div className="text-micro text-cafe-interactive/50 mb-0.5">{statusGroup(title, items.length)}</div>
      <div className="space-y-0.5">
        {items.map((item) => (
          <div
            key={item.path}
            className="flex items-center gap-1.5 text-xs font-mono text-cafe-black/80 py-0.5 px-1 rounded hover:bg-cafe-surface-sunken/30"
          >
            <StatusBadge status={item.status} variant={variant} />
            <span className="truncate" title={item.path}>
              {item.path}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function HealthSectionBody({
  health,
  healthLoading,
  healthError,
  copy,
}: {
  health: GitHealthResult | null;
  healthLoading: boolean;
  healthError: string | null;
  copy: GitCopy;
}) {
  if (!health) {
    return (
      <div className="text-micro text-cafe-interactive/40">
        {healthError ? copy.healthFailed : healthLoading ? copy.healthLoading : copy.healthUnavailable}
      </div>
    );
  }
  const drift = health.runtimeDrift;
  return (
    <div className="space-y-2 text-xs">
      <div className="text-cafe-black/80">
        {drift?.available ? copy.drift(drift.aheadOfMain, drift.behindMain) : copy.driftUnavailable}
      </div>
      {drift?.available && (drift.runtimeHead || drift.mainHead) && (
        <div className="text-micro text-cafe-interactive/40 font-mono">
          {copy.driftHeads(drift.runtimeHead, drift.mainHead)}
        </div>
      )}
      {drift?.available && drift.behindCommits.length > 0 && (
        <div>
          <div className="text-micro text-cafe-interactive/50 mb-0.5">
            {copy.behindMainCommits(drift.behindCommits.length)}
          </div>
          <div className="space-y-0.5">
            {drift.behindCommits.map((commit) => (
              <div key={commit.short} className="flex items-center gap-1.5 text-micro font-mono">
                <span className="text-cafe-accent/70 shrink-0">{commit.short}</span>
                <span className="text-cafe-black/70 truncate">{commit.subject}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {health.staleBranches.length > 0 && (
        <div>
          <div className="text-micro text-cafe-interactive/50 mb-0.5">
            {copy.staleBranches(health.staleBranches.length)}
          </div>
          <div className="space-y-0.5">
            {health.staleBranches.map((branch) => {
              const relDate = formatRelativeDate(branch.lastCommitDate, copy);
              return (
                <div key={branch.name} className="flex items-center gap-1.5 text-micro">
                  <span className="font-mono text-cafe-black/70 truncate">{branch.name}</span>
                  <span className="text-cafe-interactive/40 shrink-0 ml-auto">
                    {relDate ? `${branch.author} · ${relDate}` : branch.author}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {health.worktrees.length > 0 && (
        <div>
          <div className="text-micro text-cafe-interactive/50 mb-0.5">{copy.worktrees(health.worktrees.length)}</div>
          <div className="space-y-0.5">
            {health.worktrees.map((worktree) => {
              const dirName = worktree.path.split('/').filter(Boolean).pop() ?? worktree.path;
              return (
                <div key={worktree.path} className="flex items-center gap-1.5 text-micro">
                  <span className="font-mono text-cafe-black/70 truncate" title={worktree.path}>
                    {worktree.branch}
                  </span>
                  <span className="text-cafe-interactive/40 truncate" title={worktree.path}>
                    {dirName}
                  </span>
                  {worktree.head && (
                    <span className="font-mono text-cafe-interactive/40 shrink-0">{worktree.head}</span>
                  )}
                  <span
                    className={`shrink-0 ml-auto ${worktree.isOrphan ? 'text-conn-amber-text' : 'text-cafe-interactive/40'}`}
                  >
                    {worktree.isOrphan ? copy.orphaned : copy.inUse}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function CommitRow({
  commit,
  isExpanded,
  onToggle,
  copy,
}: {
  commit: GitCommit;
  isExpanded: boolean;
  onToggle: () => void;
  copy: GitCopy;
}) {
  return (
    // biome-ignore lint/a11y: the nested native button owns keyboard/screen-reader semantics; the wrapper restores the surrounding pointer hit area
    <div
      onClick={(event) => {
        if (isRowPrimaryActionTarget(event.target, event.currentTarget)) onToggle();
      }}
      className={`w-full cursor-pointer text-left px-2 py-1.5 text-xs hover:bg-cafe-surface-sunken/30 transition-colors border-b border-cafe-subtle/20 ${isExpanded ? 'bg-cafe-surface-sunken/20' : ''}`}
    >
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-2 text-left">
        <span className="font-mono text-cafe-accent/70 text-micro shrink-0">{commit.short}</span>
        <span className="text-micro font-semibold text-cafe-accent">
          {isExpanded ? copy.collapseDetail : copy.expandDetail}
        </span>
        <span className="text-micro text-cafe-interactive/40 shrink-0 ml-auto">
          {formatRelativeDate(commit.date, copy)}
        </span>
      </button>
      <ExpandableProse
        text={commit.subject}
        lines={2}
        className="mt-1"
        contentClassName="text-xs leading-4 text-cafe-black/80"
      />
      <div className="text-micro text-cafe-interactive/40 mt-0.5">{commit.author}</div>
    </div>
  );
}

/**
 * F322 v2（北极星 §1.13 代码 5）：分支、领先/落后、状态 / 仓库健康 / 提交三块都能收起，
 * 底部固定只读说明。数据沿原 useGitPanel / useGitHealth 只读接口，不加任何写动作。
 */
export function GitPanelV2() {
  const copy = useShellCopy(codeToolsCopy).git;
  const { commits, status, commitDetail, loading, statusError, error, fetchCommitDetail, refresh } = useGitPanel();
  const { health, loading: healthLoading, error: healthError, fetchHealth } = useGitHealth();
  const [expandedHash, setExpandedHash] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState({ status: false, health: false, commits: false });

  useEffect(() => {
    refresh();
    fetchHealth();
  }, [refresh, fetchHealth]);

  const handleRefresh = () => {
    void refresh();
    void fetchHealth();
  };

  const handleToggleCommit = (hash: string) => {
    if (expandedHash === hash) {
      setExpandedHash(null);
    } else {
      setExpandedHash(hash);
      fetchCommitDetail(hash);
    }
  };

  const toggleSection = (key: keyof typeof collapsed) => setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));

  const totalChanges = status ? status.staged.length + status.unstaged.length + status.untracked.length : 0;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-cafe-subtle/40">
        <span className="text-xs font-semibold text-cafe-black truncate">
          {status?.branch ? copy.branch(status.branch) : copy.fallbackTitle}
        </span>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={loading}
          className="text-micro text-cafe-accent hover:text-cafe-accent/80 disabled:opacity-50 shrink-0"
        >
          {loading ? '…' : copy.refresh}
        </button>
      </div>

      {error && (
        <div className="px-3 py-2 text-xs text-conn-red-text bg-conn-red-bg/80 border-b border-[var(--semantic-critical-surface)]">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        <Section
          title={status ? copy.status(totalChanges) : copy.statusTitle}
          collapsed={collapsed.status}
          onToggle={() => toggleSection('status')}
        >
          {status === null ? (
            <div className="text-micro text-cafe-interactive/40">
              {statusError ? copy.statusFailed : copy.statusLoading}
            </div>
          ) : totalChanges === 0 ? (
            <div className="text-xs text-conn-green-text">{copy.workingTreeClean}</div>
          ) : (
            <>
              <StatusGroup title={copy.staged} items={status.staged} variant="staged" statusGroup={copy.statusGroup} />
              <StatusGroup
                title={copy.modified}
                items={status.unstaged}
                variant="unstaged"
                statusGroup={copy.statusGroup}
              />
              <StatusGroup
                title={copy.untracked}
                items={status.untracked}
                variant="untracked"
                statusGroup={copy.statusGroup}
              />
            </>
          )}
        </Section>

        <Section title={copy.health} collapsed={collapsed.health} onToggle={() => toggleSection('health')}>
          <HealthSectionBody health={health} healthLoading={healthLoading} healthError={healthError} copy={copy} />
        </Section>

        <Section
          title={copy.commits(commits.length)}
          collapsed={collapsed.commits}
          onToggle={() => toggleSection('commits')}
        >
          {commits.length === 0 && !loading ? (
            <div className="py-3 text-xs text-cafe-interactive/40 text-center">{copy.noCommits}</div>
          ) : (
            commits.map((commit) => (
              <div key={commit.hash}>
                <CommitRow
                  commit={commit}
                  isExpanded={expandedHash === commit.hash}
                  onToggle={() => handleToggleCommit(commit.hash)}
                  copy={copy}
                />
                {expandedHash === commit.hash && commitDetail && commitDetail.hash === commit.hash && (
                  <div className="bg-cafe-surface-sunken/10 px-3 py-2 border-b border-cafe-subtle/30">
                    {commitDetail.files.length === 0 ? (
                      <div className="text-micro text-cafe-interactive/40">{copy.noFileChanges}</div>
                    ) : (
                      <div className="space-y-0.5">
                        {commitDetail.files.map((f) => (
                          <div key={f.path} className="flex items-center justify-between text-micro font-mono">
                            <span className="text-cafe-black/70 truncate">{f.path}</span>
                            <span className="text-cafe-interactive/40 shrink-0 ml-2">{f.summary}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </Section>
      </div>

      <div className="px-3 py-1.5 border-t border-cafe-subtle/40 text-micro text-cafe-interactive/40">
        {copy.readOnlyFooter}
      </div>
    </div>
  );
}
