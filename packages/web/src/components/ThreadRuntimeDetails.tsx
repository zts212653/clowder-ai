'use client';

import type { ThreadRuntimeCurrentExecution, ThreadRuntimeSessionSummary } from '@cat-cafe/shared';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { formatCatName, useCatData } from '@/hooks/useCatData';
import { useThreadRuntimeBrief } from '@/hooks/useThreadRuntimeBrief';
import { useChatStore } from '@/stores/chatStore';
import { ThreadExecutionBar } from './ThreadExecutionBar';

export function ThreadRuntimeDetails({ threadId }: { readonly threadId: string }) {
  const { brief, loading, error, refetch } = useThreadRuntimeBrief(threadId);
  const { getCatById } = useCatData();
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const resolveCatName = (catId: string) => {
    const cat = getCatById(catId);
    return cat ? formatCatName(cat) : '一只猫';
  };
  const openTasks = () => {
    const store = useChatStore.getState();
    store.setWorkspaceMode('tasks');
    store.setRightPanelMode('workspace');
  };

  return (
    <div className="min-h-full bg-[var(--console-panel-bg)]" data-testid="thread-runtime-details">
      <ThreadExecutionBar threadId={threadId} />
      <div className="space-y-3 p-4">
        {loading && !brief && <p className="text-sm text-cafe-muted">正在读取运行详情…</p>}
        {error && !brief && (
          <RuntimeSection title="运行详情暂时无法确认">
            <p className="text-xs text-cafe-muted">不会使用旧执行记录猜测当前状态。</p>
            <button type="button" className="mt-2 text-xs font-medium text-cafe-accent" onClick={refetch}>
              重新读取
            </button>
          </RuntimeSection>
        )}
        {brief && (
          <>
            {brief.currentExecutions.length === 0 && (
              <RuntimeSection title="当前没有猫在执行">
                <p className="text-xs text-cafe-muted">可以继续查看最近 Session、关键进展与下一步。</p>
              </RuntimeSection>
            )}
            <PlanSection executions={brief.currentExecutions} resolveCatName={resolveCatName} />
            <RuntimeSection title="关键进展与下一步">
              <p className="text-xs text-cafe-secondary">{brief.latestProgress?.headline ?? '还没有关键进展记录'}</p>
              <p className="mt-1 text-xs text-cafe-muted">下一步：{brief.nextStep ?? '尚未明确'}</p>
              {brief.openWorkTaskCount > 0 && (
                <button type="button" className="mt-2 text-xs font-medium text-cafe-accent" onClick={openTasks}>
                  有 {brief.openWorkTaskCount} 项待办 · 查看毛线球
                </button>
              )}
            </RuntimeSection>
            <SessionSection sessions={brief.recentSessions} resolveCatName={resolveCatName} />
            <AnchorSection anchors={brief.anchors} />
            <RuntimeSection title="技术诊断">
              <button
                type="button"
                className="text-xs font-medium text-cafe-secondary hover:text-cafe-black"
                aria-expanded={diagnosticsOpen}
                onClick={() => setDiagnosticsOpen((open) => !open)}
              >
                {diagnosticsOpen ? '隐藏技术信息' : '展开技术信息'}
              </button>
              {diagnosticsOpen && <TechnicalDiagnostics sessions={brief.recentSessions} />}
            </RuntimeSection>
          </>
        )}
      </div>
    </div>
  );
}

function PlanSection({
  executions,
  resolveCatName,
}: {
  readonly executions: readonly ThreadRuntimeCurrentExecution[];
  readonly resolveCatName: (catId: string) => string;
}) {
  const planned = executions.filter((execution) => execution.plan && execution.plan.tasks.length > 0);
  return (
    <RuntimeSection title="本轮计划">
      {planned.length === 0 && <p className="text-xs text-cafe-muted">本轮没有可用计划</p>}
      {planned.map((execution) => (
        <div key={execution.catId} className="mb-3 last:mb-0">
          <p className="mb-1.5 text-xs font-medium text-cafe-secondary">{resolveCatName(execution.catId)}</p>
          <div className="space-y-1">
            {execution.plan?.tasks.map((task) => (
              <p key={task.id} className="flex gap-2 text-xs text-cafe-secondary">
                <span aria-hidden="true">
                  {task.status === 'completed' ? '✓' : task.status === 'in_progress' ? '◉' : '○'}
                </span>
                <span className={task.status === 'completed' ? 'text-cafe-muted line-through' : ''}>
                  {task.status === 'in_progress' ? (task.activeForm ?? task.subject) : task.subject}
                </span>
              </p>
            ))}
          </div>
        </div>
      ))}
    </RuntimeSection>
  );
}

function SessionSection({
  sessions,
  resolveCatName,
}: {
  readonly sessions: readonly ThreadRuntimeSessionSummary[];
  readonly resolveCatName: (catId: string) => string;
}) {
  return (
    <RuntimeSection title="最近 Session">
      {sessions.length === 0 && <p className="text-xs text-cafe-muted">还没有可恢复的 Session 记录</p>}
      {sessions.map((session) => (
        <div key={session.sessionId} className="mb-2 rounded-lg bg-cafe-surface-sunken px-3 py-2 last:mb-0">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="font-medium text-cafe-secondary">{resolveCatName(session.catId)}</span>
            <span className="text-cafe-muted">{sessionStatusLabel(session.status)}</span>
          </div>
          <p className="mt-1 text-micro text-cafe-muted">
            更新于 {formatAge(session.updatedAt)} · {session.messageCount} 条消息{formatUsage(session)}
          </p>
          {session.contextHealth && (
            <p className="mt-1 text-micro text-cafe-muted">
              上下文 {Math.round(session.contextHealth.fillRatio * 100)}% ·{' '}
              {session.contextHealth.source === 'exact' ? '精确值' : '估算值'}
            </p>
          )}
        </div>
      ))}
    </RuntimeSection>
  );
}

function AnchorSection({
  anchors,
}: {
  readonly anchors: {
    readonly worktrees: readonly string[];
    readonly prs: readonly { readonly repo: string; readonly number: number }[];
    readonly issues: readonly { readonly repo: string; readonly number: number }[];
    readonly features: readonly string[];
  };
}) {
  const labels = [
    anchors.worktrees.length > 0 ? `${anchors.worktrees.length} 个工作区` : null,
    anchors.prs.length > 0 ? `${anchors.prs.length} 个 PR` : null,
    anchors.issues.length > 0 ? `${anchors.issues.length} 个 Issue` : null,
    anchors.features.length > 0 ? `${anchors.features.length} 个 Feature` : null,
  ].filter((value): value is string => value !== null);
  if (labels.length === 0) return null;
  return (
    <RuntimeSection title="关联环境与产物">
      <p className="text-xs text-cafe-secondary">{labels.join(' · ')}</p>
    </RuntimeSection>
  );
}

function TechnicalDiagnostics({ sessions }: { readonly sessions: readonly ThreadRuntimeSessionSummary[] }) {
  return (
    <div className="mt-2 space-y-2 rounded-lg bg-cafe-surface-sunken p-3 font-mono text-micro text-cafe-muted">
      {sessions.length === 0 && <p>没有 Session 诊断信息</p>}
      {sessions.map((session) => (
        <div key={session.sessionId}>
          <p>session: {session.sessionId}</p>
          {session.cliSessionId && <p>runtime session: {session.cliSessionId}</p>}
          {session.workingDirectory && <p>working directory: {session.workingDirectory}</p>}
        </div>
      ))}
    </div>
  );
}

function RuntimeSection({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="rounded-xl border border-cafe-subtle bg-cafe-surface p-3">
      <h3 className="mb-2 text-xs font-semibold text-cafe-secondary">{title}</h3>
      {children}
    </section>
  );
}

function sessionStatusLabel(status: ThreadRuntimeSessionSummary['status']): string {
  if (status === 'active') return '活跃';
  if (status === 'sealing') return '正在封存';
  return '已封存';
}

function formatAge(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86_400)} 天前`;
}

function formatUsage(session: ThreadRuntimeSessionSummary): string {
  if (!session.usage) return '';
  const tokens = (session.usage.inputTokens ?? 0) + (session.usage.outputTokens ?? 0);
  const tokenText = tokens > 0 ? ` · ${tokens.toLocaleString()} tokens` : '';
  const costText = typeof session.usage.costUsd === 'number' ? ` · $${session.usage.costUsd.toFixed(4)}` : '';
  return `${tokenText}${costText}`;
}
