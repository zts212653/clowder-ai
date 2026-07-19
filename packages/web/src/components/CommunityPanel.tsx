'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CommunityPanelFilters, TIME_RANGES } from '@/components/CommunityPanelFilters';
import { ClosureChecklistCard } from '@/components/community/ClosureChecklistCard';
import { UserAssignIcon } from '@/components/community/community-icons';
import { DecisionQueuePanel } from '@/components/community/DecisionQueuePanel';
import type { CommunityDecisionQueueItemModel } from '@/components/community/decision-queue-types';
import { ReconciliationFindingCard } from '@/components/community/ReconciliationFindingCard';
import { PR_ICON, TYPE_ICONS } from '@/components/community-panel-icons';
import { DirectionCard, type DirectionCardProps } from '@/components/DirectionCard';
import { pushThreadRouteWithHistory } from '@/components/ThreadSidebar/thread-navigation';
import { useCatNameResolver } from '@/hooks/useCatNameResolver';

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}小时前`;
  return `${Math.floor(diff / 86_400_000)}天前`;
}

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
  assignedThreadName?: string | null;
  directionCard: { entries: Array<Record<string, unknown>>; consensus?: Record<string, unknown> } | null;
  closureChecklist?: {
    readyToClose: boolean;
    blockers: Array<{ kind: 'fixed-not-reported' | 'not-in-closeable-state'; detail: string }>;
    waiverPresent: boolean;
  };
  closureWaiver?: { reason: string; actor: string; evidence: string } | null;
  updatedAt: number;
}

interface PrBoardItem {
  taskId: string;
  threadId?: string | null;
  title: string;
  status: string;
  group: string;
  prNumber?: number | null;
  ownerCatId?: string | null;
  author?: string;
  replyState?: string;
  updatedAt: number;
}

interface BoardData {
  repo: string;
  issues: CommunityIssueItem[];
  prItems: PrBoardItem[];
}

interface ReconciliationFinding {
  findingId: string;
  subjectKey: string;
  findingKind: string;
  severity: string;
  message: string;
  status: 'open' | 'acknowledged' | 'resolved' | 'waived';
  waiver: { reason: string; actor: string; evidence: string } | null;
  evidenceFingerprint: string | null;
  createdAt: number;
  updatedAt: number;
}

interface DecisionQueueResponse {
  repo: string;
  items: CommunityDecisionQueueItemModel[];
  warnings?: string[];
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
  { key: 'unreplied', label: 'PR 未回复' },
  { key: 'replied', label: 'PR 已回复' },
  { key: 'has-new-activity', label: '有新动态' },
  { key: 'merged', label: '已合入' },
  { key: 'closed', label: '已关闭' },
] as const;

const ISSUE_STATE_COLORS: Record<string, string> = {
  unreplied: 'text-cafe-accent',
  discussing: 'text-cafe-crosspost',
  'pending-decision': 'text-conn-amber-text',
  accepted: 'text-conn-green-text',
  declined: 'text-cafe-muted',
  closed: 'text-gray-400',
};

const PR_GROUP_COLORS: Record<string, string> = {
  unreplied: 'text-cafe-accent',
  replied: 'text-conn-green-text',
  'has-new-activity': 'text-conn-amber-text',
  merged: 'text-conn-green-text',
  closed: 'text-gray-400',
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
      <span className="text-micro text-cafe-muted bg-cafe-surface-elevated rounded-full px-1.5 py-0.5">{count}</span>
      <span className="ml-auto text-micro text-cafe-muted">{collapsed ? '▸' : '▾'}</span>
    </button>
  );
}

function IssueRow({
  item,
  expanded,
  onNavigate,
  onDispatch,
  onToggleExpand,
  onResolve,
  onRefresh,
}: {
  item: CommunityIssueItem;
  expanded: boolean;
  onNavigate: (threadId: string) => void;
  onDispatch: (issueId: string) => void;
  onToggleExpand: (issueId: string) => void;
  onResolve: (
    issueId: string,
    decision: 'accepted' | 'declined',
    opts?: {
      routeRecommendation?: { kind: string; threadId?: string };
    },
  ) => Promise<void>;
  onRefresh: () => void;
}) {
  const resolveCatName = useCatNameResolver();
  const color = ISSUE_STATE_COLORS[item.state] ?? 'text-cafe-muted';
  const icon = TYPE_ICONS[item.issueType] ?? TYPE_ICONS.question;
  const hasDirectionCard =
    item.state === 'pending-decision' &&
    item.directionCard?.entries?.some((e: Record<string, unknown>) => e.authoredByRole === 'narrator');
  const hasClosureChecklist = item.closureChecklist != null;
  const isExpandable = hasDirectionCard || hasClosureChecklist;
  const handleClick = () => {
    if (isExpandable) {
      onToggleExpand(item.id);
    } else if (item.assignedThreadId) {
      onNavigate(item.assignedThreadId);
    }
  };
  return (
    <>
      <div
        data-testid={`issue-row-${item.id}`}
        onClick={handleClick}
        className={`flex items-center gap-2 px-3 py-1.5 hover:bg-cafe-surface-elevated/30 text-xs transition-colors ${
          expanded ? 'bg-cafe-surface-elevated/50 border-l-2 border-l-cafe-accent' : ''
        } ${item.assignedThreadId || isExpandable ? 'cursor-pointer' : 'cursor-default opacity-70'}`}
      >
        <span className={color}>{icon}</span>
        <a
          href={`https://github.com/${item.repo}/issues/${item.issueNumber}`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="text-cafe-muted text-micro hover:text-cafe-accent hover:underline"
        >
          #{item.issueNumber}
        </a>
        <span className="truncate flex-1 text-cafe-secondary">{item.title}</span>
        {item.assignedCatId && (
          <span
            data-testid={`assignment-chip-${item.id}`}
            className="inline-flex items-center gap-0.5 text-micro text-cafe-accent/80 bg-cafe-accent/5 px-1.5 py-0.5 rounded-full shrink-0"
            title={
              item.assignedThreadName
                ? `${resolveCatName(item.assignedCatId)} → ${item.assignedThreadName}`
                : item.assignedThreadId
                  ? `${resolveCatName(item.assignedCatId)} → ${item.assignedThreadId}`
                  : resolveCatName(item.assignedCatId)
            }
          >
            <UserAssignIcon />
            <span>{resolveCatName(item.assignedCatId)}</span>
            {item.assignedThreadName && (
              <>
                <span className="text-cafe-muted/40">→</span>
                <span className="text-cafe-muted/70 max-w-[8rem] truncate">{item.assignedThreadName}</span>
              </>
            )}
          </span>
        )}
        <span className="text-micro text-cafe-muted">{relativeTime(item.updatedAt)}</span>
        {item.state === 'unreplied' && (
          <button
            type="button"
            data-testid={`dispatch-btn-${item.id}`}
            onClick={(e) => {
              e.stopPropagation();
              onDispatch(item.id);
            }}
            className="text-xs text-cafe-crosspost bg-cafe-crosspost/10 px-1.5 py-0.5 rounded hover:bg-cafe-crosspost/20 transition-colors"
          >
            发送给系统猫
          </button>
        )}
        {item.replyState === 'unreplied' && item.state !== 'unreplied' && (
          <span className="text-xs text-cafe-accent bg-cafe-accent/10 px-1 rounded">未回复</span>
        )}
      </div>
      {expanded && hasDirectionCard && item.directionCard && (
        <DirectionCard
          issueId={item.id}
          directionCard={item.directionCard as unknown as DirectionCardProps['directionCard']}
          onResolve={onResolve}
        />
      )}
      {expanded && !hasDirectionCard && item.closureChecklist && (
        <div className="px-3 py-2">
          <ClosureChecklistCard
            issueId={item.id}
            checklist={item.closureChecklist}
            waiver={item.closureWaiver ?? null}
            actor={item.assignedCatId ?? 'system'}
            onAction={() => {
              // report/waive actions handled by sub-forms (ReportAuditForm / WaiverAuditForm).
              // Close action: no canonical case.closed event endpoint exists yet —
              // wiring to legacy PATCH would bypass Event Log/projection (R2 review).
              // Close button shows readiness (INV-D6.1) but actual close comes from
              // GitHub issue.closed webhook → reconciler → event log.
              onRefresh();
            }}
          />
        </div>
      )}
    </>
  );
}

function PrRow({
  item,
  repo,
  onNavigate,
}: {
  item: PrBoardItem;
  repo: string;
  onNavigate: (threadId: string) => void;
}) {
  const resolveCatName = useCatNameResolver();
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
      {item.prNumber != null && (
        <a
          href={`https://github.com/${repo}/pull/${item.prNumber}`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="text-cafe-muted text-micro hover:text-cafe-accent hover:underline"
        >
          #{item.prNumber}
        </a>
      )}
      <span className="truncate flex-1 text-cafe-secondary">{item.title}</span>
      {item.author && <span className="text-micro text-cafe-muted">@{item.author}</span>}
      {item.ownerCatId && <span className="text-micro text-cafe-accent/60">{resolveCatName(item.ownerCatId)}</span>}
      <span className="text-micro text-cafe-muted">{relativeTime(item.updatedAt)}</span>
    </div>
  );
}

export function CommunityPanel({ threadId }: { threadId?: string }) {
  const [board, setBoard] = useState<BoardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [repo, setRepo] = useState('');
  const [collapsedIssues, setCollapsedIssues] = useState<Record<string, boolean>>({
    accepted: true,
    declined: true,
  });
  const [collapsedPrs, setCollapsedPrs] = useState<Record<string, boolean>>({
    merged: true,
    closed: true,
  });
  const [stateFilter, setStateFilter] = useState('all');
  const [catFilter, setCatFilter] = useState('all');
  const [timeRange, setTimeRange] = useState('all');
  const [repos, setRepos] = useState<string[]>([]);
  const [expandedIssue, setExpandedIssue] = useState<string | null>(null);
  const [findings, setFindings] = useState<ReconciliationFinding[]>([]);
  const [collapsedFindings, setCollapsedFindings] = useState(false);
  const [decisionQueue, setDecisionQueue] = useState<CommunityDecisionQueueItemModel[]>([]);
  const [decisionQueueWarnings, setDecisionQueueWarnings] = useState<string[]>([]);
  const [decisionQueueLoading, setDecisionQueueLoading] = useState(false);
  const latestRepoRef = useRef('');
  const boardRequestIdRef = useRef(0);
  const decisionQueueRequestIdRef = useRef(0);
  latestRepoRef.current = repo.trim();

  const fetchFindings = useCallback(async () => {
    try {
      const res = await fetch('/api/community-findings?status=open,acknowledged');
      if (res.ok) {
        const data = await res.json();
        setFindings(data.findings ?? []);
      }
    } catch {
      /* network error — keep stale findings */
    }
  }, []);

  const fetchBoard = useCallback(async () => {
    const activeRepo = repo.trim();
    const requestId = ++boardRequestIdRef.current;
    if (!activeRepo) {
      setBoard(null);
      setExpandedIssue(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/community-board?repo=${encodeURIComponent(activeRepo)}`);
      if (res.ok) {
        const data = await res.json();
        if (requestId === boardRequestIdRef.current && latestRepoRef.current === activeRepo) {
          setBoard(data);
        }
      }
    } catch {
      /* network error — keep stale data */
    } finally {
      if (requestId === boardRequestIdRef.current && latestRepoRef.current === activeRepo) {
        setLoading(false);
      }
    }
  }, [repo]);

  const fetchDecisionQueue = useCallback(async () => {
    const activeRepo = repo.trim();
    const requestId = ++decisionQueueRequestIdRef.current;
    if (!activeRepo) {
      setDecisionQueue([]);
      setDecisionQueueWarnings([]);
      setDecisionQueueLoading(false);
      return;
    }
    setDecisionQueueLoading(true);
    try {
      const res = await fetch(`/api/community-decision-queue?repo=${encodeURIComponent(activeRepo)}`);
      if (res.ok) {
        const data = (await res.json()) as DecisionQueueResponse;
        if (requestId === decisionQueueRequestIdRef.current && latestRepoRef.current === activeRepo) {
          setDecisionQueue(Array.isArray(data.items) ? data.items : []);
          setDecisionQueueWarnings(Array.isArray(data.warnings) ? data.warnings : []);
        }
      }
    } catch {
      /* network error — keep stale queue */
    } finally {
      if (requestId === decisionQueueRequestIdRef.current && latestRepoRef.current === activeRepo) {
        setDecisionQueueLoading(false);
      }
    }
  }, [repo]);

  const refreshCommunityViews = useCallback(async () => {
    await Promise.all([fetchBoard(), fetchFindings(), fetchDecisionQueue()]);
  }, [fetchBoard, fetchFindings, fetchDecisionQueue]);

  const handleSync = useCallback(async () => {
    const activeRepo = repo.trim();
    if (!activeRepo) return;
    setLoading(true);
    try {
      await Promise.all([
        fetch(`/api/community-issues/sync?repo=${encodeURIComponent(activeRepo)}`, { method: 'POST' }),
        fetch(`/api/community-issues/sync-prs?repo=${encodeURIComponent(activeRepo)}`, { method: 'POST' }),
      ]);
      if (latestRepoRef.current === activeRepo) {
        await refreshCommunityViews();
      }
    } catch {
      /* network error — keep stale data */
    } finally {
      if (latestRepoRef.current === activeRepo) {
        setLoading(false);
      }
    }
  }, [repo, refreshCommunityViews]);

  useEffect(() => {
    refreshCommunityViews();
    const timer = setInterval(() => {
      refreshCommunityViews();
    }, AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refreshCommunityViews]);

  useEffect(() => {
    fetch('/api/community-repos')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        const repoCandidates: unknown[] = Array.isArray(data?.repos) ? data.repos : [];
        const nextRepos = repoCandidates.filter((candidate): candidate is string => typeof candidate === 'string');
        setRepos(nextRepos);
        setRepo((currentRepo) => currentRepo || nextRepos[0] || '');
      })
      .catch(() => {});
  }, []);

  const dispatchIssue = useCallback(
    async (issueId: string) => {
      try {
        const res = await fetch(`/api/community-issues/${issueId}/dispatch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ threadId }),
        });
        if (res.ok) refreshCommunityViews();
      } catch {
        /* ignore */
      }
    },
    [refreshCommunityViews, threadId],
  );

  const navigateToThread = useCallback((threadId: string) => {
    pushThreadRouteWithHistory(threadId, window);
  }, []);

  const toggleExpand = useCallback((issueId: string) => {
    setExpandedIssue((prev) => (prev === issueId ? null : issueId));
  }, []);

  const resolveIssue = useCallback(
    async (
      issueId: string,
      decision: 'accepted' | 'declined',
      opts?: {
        routeRecommendation?: { kind: string; threadId?: string };
      },
    ) => {
      try {
        const res = await fetch(`/api/community-issues/${issueId}/resolve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision, routeRecommendation: opts?.routeRecommendation }),
        });
        if (res.ok) {
          setExpandedIssue(null);
          refreshCommunityViews();
        }
      } catch {
        /* network error */
      }
    },
    [refreshCommunityViews],
  );

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
        onSync={handleSync}
      />

      {/* Stats */}
      <div className="flex items-center gap-3 px-3 py-1.5 text-micro text-cafe-muted border-b border-cafe-subtle/20">
        <span>Issues: {totalIssues}</span>
        <span>PRs: {totalPrs}</span>
        <span>Queue: {decisionQueue.length}</span>
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
            <DecisionQueuePanel
              items={decisionQueue}
              warnings={decisionQueueWarnings}
              loading={decisionQueueLoading}
              fallbackActor="system"
              onActionComplete={refreshCommunityViews}
              onOpenThread={navigateToThread}
            />

            {/* Issues */}
            <div data-testid="raw-issues-section" className="border-b border-cafe-subtle/20">
              <div className="px-3 py-1.5 text-micro font-bold text-cafe-muted uppercase tracking-wider">Issues</div>
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
                        <IssueRow
                          key={item.id}
                          item={item}
                          expanded={expandedIssue === item.id}
                          onNavigate={navigateToThread}
                          onDispatch={dispatchIssue}
                          onToggleExpand={toggleExpand}
                          onResolve={resolveIssue}
                          onRefresh={refreshCommunityViews}
                        />
                      ))}
                  </div>
                );
              })}
            </div>

            {/* PRs */}
            <div className="border-b border-cafe-subtle/20">
              <div className="px-3 py-1.5 text-micro font-bold text-cafe-muted uppercase tracking-wider">
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
                      items.map((item) => (
                        <PrRow
                          key={item.taskId}
                          item={item}
                          repo={board?.repo ?? repo.trim()}
                          onNavigate={navigateToThread}
                        />
                      ))}
                  </div>
                );
              })}
            </div>

            {/* Reconciliation Findings */}
            {findings.length > 0 && (
              <div>
                <SectionHeader
                  label="Findings"
                  count={findings.length}
                  color="text-conn-amber-text"
                  collapsed={collapsedFindings}
                  onToggle={() => setCollapsedFindings((p) => !p)}
                />
                {!collapsedFindings &&
                  findings.map((f) => (
                    <div key={f.findingId} className="px-3 py-1">
                      <ReconciliationFindingCard finding={f} />
                    </div>
                  ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
