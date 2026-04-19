'use client';

import { useCallback, useEffect, useState } from 'react';
import { CommunityPanelFilters, TIME_RANGES } from '@/components/CommunityPanelFilters';
import { PR_ICON, TYPE_ICONS } from '@/components/community-panel-icons';
import { pushThreadRouteWithHistory } from '@/components/ThreadSidebar/thread-navigation';

interface CommunityIssueItem {
  id: string;
  repo: string;
  issueNumber: number;
  issueType: string;
  title: string;
  state: string;
  replyState: string;
  consensusState?: string;
  assignedThreadId: string | null;
  assignedCatId: string | null;
  updatedAt: number;
}

interface PrBoardItem {
  taskId: string;
  threadId: string;
  title: string;
  status: string;
  group: string;
  updatedAt: number;
}

interface BoardData {
  repo: string;
  issues: CommunityIssueItem[];
  prItems: PrBoardItem[];
}

const ISSUE_SECTIONS = [
  { key: 'unreplied', label: '未回复' },
  { key: 'discussing', label: '讨论中' },
  { key: 'pending-decision', label: '待决策' },
  { key: 'accepted', label: '已接受' },
  { key: 'declined', label: '已拒绝' },
  { key: 'closed', label: '已关闭' },
] as const;

const PR_SECTIONS = [
  { key: 'in-review', label: '审核中' },
  { key: 're-review-needed', label: '需重审' },
  { key: 'has-conflict', label: '有冲突' },
  { key: 'completed', label: '已完成' },
] as const;

const ISSUE_STATE_COLORS: Record<string, string> = {
  unreplied: 'text-cafe-accent',
  discussing: 'text-cafe-crosspost',
  'pending-decision': 'text-amber-600',
  accepted: 'text-green-600',
  declined: 'text-cafe-muted',
  closed: 'text-gray-400',
};

const PR_GROUP_COLORS: Record<string, string> = {
  'in-review': 'text-cafe-crosspost',
  're-review-needed': 'text-amber-600',
  'has-conflict': 'text-cafe-accent',
  completed: 'text-green-600',
};

const AUTO_REFRESH_MS = 5 * 60 * 1000;

function SectionHeader({
  label,
  count,
  color,
  collapsed,
  onToggle,
}: {
  label: string;
  count: number;
  color: string;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-cafe-surface-elevated/50 transition-colors"
    >
      <span className={`text-xs font-semibold ${color}`}>{label}</span>
      <span className="text-[10px] text-cafe-muted bg-cafe-surface-elevated rounded-full px-1.5 py-0.5">{count}</span>
      <span className="ml-auto text-[10px] text-cafe-muted">{collapsed ? '▸' : '▾'}</span>
    </button>
  );
}

function IssueRow({
  item,
  onNavigate,
  onDispatch,
}: {
  item: CommunityIssueItem;
  onNavigate: (threadId: string) => void;
  onDispatch: (issueId: string) => void;
}) {
  const color = ISSUE_STATE_COLORS[item.state] ?? 'text-cafe-muted';
  const icon = TYPE_ICONS[item.issueType] ?? TYPE_ICONS.question;
  const handleClick = () => {
    if (item.assignedThreadId) onNavigate(item.assignedThreadId);
  };
  return (
    <div
      data-testid={`issue-row-${item.id}`}
      onClick={handleClick}
      className={`flex items-center gap-2 px-3 py-1.5 hover:bg-cafe-surface-elevated/30 text-xs ${item.assignedThreadId ? 'cursor-pointer' : 'cursor-default opacity-70'}`}
    >
      <span className={color}>{icon}</span>
      <span className="text-cafe-muted text-[10px]">#{item.issueNumber}</span>
      <span className="truncate flex-1 text-cafe-secondary">{item.title}</span>
      {item.state === 'unreplied' && (
        <button
          type="button"
          data-testid={`dispatch-btn-${item.id}`}
          onClick={(e) => {
            e.stopPropagation();
            onDispatch(item.id);
          }}
          className="text-[9px] text-cafe-crosspost bg-cafe-crosspost/10 px-1.5 py-0.5 rounded hover:bg-cafe-crosspost/20 transition-colors"
        >
          发送给系统猫
        </button>
      )}
      {item.replyState === 'unreplied' && item.state !== 'unreplied' && (
        <span className="text-[9px] text-cafe-accent bg-cafe-accent/10 px-1 rounded">未回复</span>
      )}
    </div>
  );
}

function PrRow({ item, onNavigate }: { item: PrBoardItem; onNavigate: (threadId: string) => void }) {
  const color = PR_GROUP_COLORS[item.group] ?? 'text-cafe-muted';
  const handleClick = () => {
    if (item.threadId) onNavigate(item.threadId);
  };
  return (
    <div
      data-testid={`pr-row-${item.taskId}`}
      onClick={handleClick}
      className={`flex items-center gap-2 px-3 py-1.5 hover:bg-cafe-surface-elevated/30 text-xs ${item.threadId ? 'cursor-pointer' : 'cursor-default opacity-70'}`}
    >
      <span className={color}>{PR_ICON}</span>
      <span className="truncate flex-1 text-cafe-secondary">{item.title}</span>
      <span className="text-[10px] text-cafe-muted">{item.status}</span>
    </div>
  );
}

export function CommunityPanel() {
  const [board, setBoard] = useState<BoardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [repo, setRepo] = useState('zts212653/clowder-ai');
  const [collapsedIssues, setCollapsedIssues] = useState<Record<string, boolean>>({
    accepted: true,
    declined: true,
  });
  const [collapsedPrs, setCollapsedPrs] = useState<Record<string, boolean>>({
    completed: true,
  });
  const [stateFilter, setStateFilter] = useState('all');
  const [catFilter, setCatFilter] = useState('all');
  const [timeRange, setTimeRange] = useState('all');
  const [repos, setRepos] = useState<string[]>([]);

  const fetchBoard = useCallback(async () => {
    if (!repo) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/community-board?repo=${encodeURIComponent(repo)}`);
      if (res.ok) {
        setBoard(await res.json());
      }
    } catch {
      /* network error — keep stale data */
    } finally {
      setLoading(false);
    }
  }, [repo]);

  useEffect(() => {
    fetchBoard();
    const timer = setInterval(fetchBoard, AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [fetchBoard]);

  useEffect(() => {
    fetch('/api/community-repos')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.repos) setRepos(data.repos);
      })
      .catch(() => {});
  }, []);

  const dispatchIssue = useCallback(
    async (issueId: string) => {
      try {
        const res = await fetch(`/api/community-issues/${issueId}/dispatch`, { method: 'POST' });
        if (res.ok) fetchBoard();
      } catch {
        /* ignore */
      }
    },
    [fetchBoard],
  );

  const navigateToThread = useCallback((threadId: string) => {
    pushThreadRouteWithHistory(threadId, window);
  }, []);

  const filteredIssues = (board?.issues ?? []).filter((i) => {
    if (stateFilter !== 'all' && i.state !== stateFilter) return false;
    if (catFilter !== 'all' && i.assignedCatId !== catFilter) return false;
    if (timeRange !== 'all' && TIME_RANGES[timeRange]) {
      if (i.updatedAt < Date.now() - TIME_RANGES[timeRange]) return false;
    }
    return true;
  });
  const issuesByState = (state: string) => filteredIssues.filter((i) => i.state === state);

  const uniqueCats = [...new Set((board?.issues ?? []).map((i) => i.assignedCatId).filter(Boolean) as string[])];

  const prsByGroup = (group: string) => board?.prItems.filter((p) => p.group === group) ?? [];

  const totalIssues = filteredIssues.length;
  const totalPrs = board?.prItems.length ?? 0;

  return (
    <div className="flex flex-col h-full min-h-0">
      <CommunityPanelFilters
        repos={repos}
        repo={repo}
        onRepoChange={setRepo}
        stateFilter={stateFilter}
        onStateFilterChange={setStateFilter}
        catFilter={catFilter}
        onCatFilterChange={setCatFilter}
        timeRange={timeRange}
        onTimeRangeChange={setTimeRange}
        uniqueCats={uniqueCats}
        loading={loading}
        onSync={fetchBoard}
      />

      {/* Stats */}
      <div className="flex items-center gap-3 px-3 py-1.5 text-[10px] text-cafe-muted border-b border-cocreator-light/20">
        <span>Issues: {totalIssues}</span>
        <span>PRs: {totalPrs}</span>
        {loading && <span className="text-cafe-crosspost">同步中...</span>}
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {!board && !loading ? (
          <div className="flex flex-col items-center justify-center px-6 py-8 text-center">
            <h3 className="text-sm font-semibold text-cafe-secondary mb-1">社区管理看板</h3>
            <p className="text-xs text-cafe-muted leading-relaxed">
              输入仓库地址后点击同步，查看社区 issue 和 PR 状态。
            </p>
          </div>
        ) : (
          <>
            {/* Issues */}
            <div className="border-b border-cocreator-light/20">
              <div className="px-3 py-1.5 text-[10px] font-bold text-cafe-muted uppercase tracking-wider">Issues</div>
              {ISSUE_SECTIONS.map((sec) => {
                const items = issuesByState(sec.key);
                const isCollapsed = collapsedIssues[sec.key] ?? false;
                return (
                  <div key={sec.key}>
                    <SectionHeader
                      label={sec.label}
                      count={items.length}
                      color={ISSUE_STATE_COLORS[sec.key] ?? 'text-cafe-muted'}
                      collapsed={isCollapsed}
                      onToggle={() => setCollapsedIssues((p) => ({ ...p, [sec.key]: !p[sec.key] }))}
                    />
                    {!isCollapsed &&
                      items.map((item) => (
                        <IssueRow key={item.id} item={item} onNavigate={navigateToThread} onDispatch={dispatchIssue} />
                      ))}
                  </div>
                );
              })}
            </div>

            {/* PRs */}
            <div>
              <div className="px-3 py-1.5 text-[10px] font-bold text-cafe-muted uppercase tracking-wider">
                Pull Requests
              </div>
              {PR_SECTIONS.map((sec) => {
                const items = prsByGroup(sec.key);
                const isCollapsed = collapsedPrs[sec.key] ?? false;
                return (
                  <div key={sec.key}>
                    <SectionHeader
                      label={sec.label}
                      count={items.length}
                      color={PR_GROUP_COLORS[sec.key] ?? 'text-cafe-muted'}
                      collapsed={isCollapsed}
                      onToggle={() => setCollapsedPrs((p) => ({ ...p, [sec.key]: !p[sec.key] }))}
                    />
                    {!isCollapsed &&
                      items.map((item) => <PrRow key={item.taskId} item={item} onNavigate={navigateToThread} />)}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
