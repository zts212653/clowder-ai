'use client';

import React, { useEffect, useState } from 'react';
import { formatCatName, useCatData } from '@/hooks/useCatData';
import type { CatInvocationInfo, ContextHealthData } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';
import { BindNewSessionSection } from './BindNewSessionSection';
import { CloudConversationLink } from './CloudConversationLink';
import { ContextHealthBar } from './ContextHealthBar';
import { BindSessionInput, SessionIdTag } from './SessionChainInputs';
import { settingsResourceCardClass } from './SettingsResourceCard';
import { deriveSessionColors, type SessionColors } from './session-chain-colors';

/** Minimal session record from API GET /api/threads/:id/sessions */
interface SessionSummary {
  id: string;
  cliSessionId?: string;
  catId: string;
  seq: number;
  status: 'active' | 'sealing' | 'sealed';
  messageCount: number;
  sealReason?: string;
  createdAt: number;
  sealedAt?: number;
  compressionCount?: number | null;
  contextHealth?: {
    usedTokens: number;
    windowTokens: number;
    fillRatio: number;
    source: 'exact' | 'approx';
  };
  lastUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    costUsd?: number;
  };
  runtimeSession?: RuntimeSessionSummary;
}

interface RuntimeSessionSummary {
  runtime: string;
  runtimeSessionId: string;
  runtimeConversationId?: string;
  lifecycleState: string;
  lastObservedAt: number;
  retryFragment?: {
    kind: 'retry';
    retryReason: string;
    nextRuntimeSessionId?: string;
    detectedAt: number;
  };
  unexpectedRuntimeSessionSwitch?: {
    detectedAt: number;
    previousSessionId: string;
    previousRuntimeSessionId: string;
    currentRuntimeSessionId: string;
    declaredPreviousRuntimeSessionId?: string;
    reason: string;
  };
}

interface SessionChainLoadError {
  kind: 'access_denied' | 'request_failed';
  message: string;
}

const sessionCache = new Map<string, SessionSummary[]>();

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isSessionSummary(value: unknown): value is SessionSummary {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const session = value as Record<string, unknown>;
  return (
    typeof session.id === 'string' &&
    typeof session.catId === 'string' &&
    isFiniteNumber(session.seq) &&
    (session.status === 'active' || session.status === 'sealing' || session.status === 'sealed') &&
    isFiniteNumber(session.messageCount) &&
    isFiniteNumber(session.createdAt)
  );
}

export function __resetSessionChainCacheForTest() {
  sessionCache.clear();
}

export interface SessionChainPanelProps {
  threadId: string;
  catInvocations: Record<string, CatInvocationInfo>;
  activeInvocations?: Record<string, { catId: string; mode: string; startedAt?: number }>;
  onViewSession?: (sessionId: string, catId?: string) => void;
}

function timeAgo(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  return `${hr} 小时前`;
}

function sealReasonLabel(reason?: string): string {
  if (!reason) return '';
  if (reason.includes('compact')) return '压缩后封存';
  if (reason === 'threshold') return '达到阈值';
  if (reason === 'budget_exhausted') return '预算耗尽';
  if (reason === 'max_compressions') return '达到压缩上限';
  if (reason === 'manual') return '手动封存';
  if (reason === 'cli_session_replaced') return '命令行会话已替换';
  if (reason === 'unexpected_runtime_session_switch') return '运行会话意外切换';
  if (reason === 'overflow_circuit_breaker') return '上下文溢出保护';
  if (reason === 'unseal_displacement') return '恢复其他会话时封存';
  if (reason === 'manual_session_switch') return '手动切换会话';
  if (reason === 'reconcile_stuck') return '封存协调超时';
  if (reason === 'global_reaper') return '全局回收';
  if (reason === 'turn_budget_exceeded') return '回合预算耗尽';
  if (reason === 'lease_timeout') return '租约超时'; // legacy
  return reason;
}

async function restoreFailureMessage(response: Response): Promise<string | null> {
  if (response.ok) return null;
  const fallback = `恢复失败 (${response.status})`;
  try {
    const data = (await response.json()) as { error?: string };
    return data.error || fallback;
  } catch {
    return fallback;
  }
}

const RUNTIME_LIFECYCLE_LABELS: Record<string, string> = {
  active: '运行中',
  runtime_active: '运行中',
  runtime_seal_pending: '封存中',
  runtime_conflict_pending: '冲突待处理',
  runtime_disconnected: '已断开',
  runtime_error_reset: '错误后已重置',
  runtime_sealed: '已封存',
};
function runtimeLifecycleLabel(state: string): string {
  return RUNTIME_LIFECYCLE_LABELS[state] ?? state;
}

function cachePercent(cacheRead?: number, input?: number): number {
  if (!cacheRead || !input) return 0;
  return Math.round((cacheRead / input) * 100);
}

function sealedSessionSummary(session: SessionSummary): string {
  return `${session.sealedAt ? `${timeAgo(session.sealedAt)}封存` : '封存中'} · ${session.messageCount} 条消息`;
}

function sealedSessionDetails(session: SessionSummary): string | undefined {
  const details = [
    session.contextHealth ? `${Math.round(session.contextHealth.fillRatio * 100)}%` : null,
    session.compressionCount == null
      ? '压缩次数未报告'
      : session.compressionCount > 0
        ? `压缩 ${session.compressionCount} 次`
        : '未观察到压缩',
    session.sealReason ? sealReasonLabel(session.sealReason) : null,
  ].filter(Boolean);
  return details.length > 0 ? details.join(' · ') : undefined;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function unsealedSessionLifecycle(isRunning: boolean, ambiguous: boolean) {
  if (ambiguous) {
    return {
      kind: 'unverified',
      label: '当前会话待核对',
      dotClass: 'bg-conn-amber-text',
      labelClass: 'text-conn-amber-text',
    } as const;
  }
  if (isRunning) {
    return {
      kind: 'running',
      label: '正在工作',
      dotClass: 'animate-pulse bg-[var(--color-conn-emerald-text)]',
      labelClass: 'text-conn-emerald-text',
    } as const;
  }
  return {
    kind: 'resumable',
    label: '未封存 · 可续接',
    dotClass: 'bg-cafe-muted',
    labelClass: 'text-cafe-muted',
  } as const;
}

function terminalSessionLifecycle(status: SessionSummary['status']) {
  if (status === 'sealed') return { kind: 'sealed', label: '已封存' } as const;
  return { kind: 'sealing', label: '封存中' } as const;
}

export function SessionChainPanel({
  threadId,
  catInvocations,
  activeInvocations = {},
  onViewSession,
}: SessionChainPanelProps) {
  const { getCatById } = useCatData();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadedThreadId, setLoadedThreadId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<SessionChainLoadError | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [restoringSessionId, setRestoringSessionId] = useState<string | null>(null);
  const [sealingSessionId, setSealingSessionId] = useState<string | null>(null);
  const [compactingSessionId, setCompactingSessionId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [chainCollapsed, setChainCollapsed] = useState(false);
  const [sealedCollapsed, setSealedCollapsed] = useState(true);

  const colorsForCat = (catId: string): SessionColors => {
    const cat = getCatById(catId);
    return deriveSessionColors(cat?.color?.primary);
  };

  // Badge 显示猫名（与主对话气泡一致）；未知 catId 回落到原始 id。
  const labelForCat = (catId: string): string => {
    const cat = getCatById(catId);
    return cat ? formatCatName(cat) : catId;
  };

  // Data is stale when it belongs to a different thread than the one we're viewing
  const isStale = loadedThreadId !== threadId;

  // Re-fetch when any cat's sessionSealed changes
  const sealSignal = Object.values(catInvocations)
    .map((inv) => `${inv.sessionSeq ?? ''}:${inv.sessionSealed ?? ''}`)
    .join(',');

  // Fetch sessions into a thread-owned result set. Cached data for the requested
  // thread may render immediately; data owned by another thread never may.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sealSignal+refreshKey intentionally trigger re-fetch
  useEffect(() => {
    let cancelled = false;
    const cached = sessionCache.get(threadId);
    if (cached) {
      setSessions(cached);
      setLoadedThreadId(threadId);
    }
    setLoadError(null);
    setLoading(true);
    apiFetch(`/api/threads/${threadId}/sessions`)
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          let code: string | undefined;
          try {
            code = ((await res.json()) as { code?: string }).code;
          } catch {
            // A non-JSON failure still gets an honest typed fallback below.
          }
          if (cancelled) return;
          if (res.status === 403 || code === 'THREAD_ACCESS_DENIED') {
            sessionCache.delete(threadId);
            setSessions([]);
            setLoadedThreadId(null);
            setLoadError({
              kind: 'access_denied',
              message: '无权查看这条对话的会话记录',
            });
          } else {
            setLoadError({ kind: 'request_failed', message: `会话记录加载失败 (${res.status})` });
          }
          return;
        }
        const data = (await res.json()) as { sessions?: unknown };
        if (!Array.isArray(data.sessions) || !data.sessions.every(isSessionSummary)) {
          throw new Error('Session Chain response contained an invalid sessions collection');
        }
        const sessions = data.sessions;
        if (!cancelled) {
          sessionCache.set(threadId, sessions);
          setSessions(sessions);
          setLoadedThreadId(threadId);
          setLoadError(null);
        }
      })
      .catch(() => {
        // Keep the last result cached under its owner, but never project it under this thread.
        if (!cancelled) setLoadError({ kind: 'request_failed', message: '会话记录加载失败' });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [threadId, sealSignal, refreshKey]);

  const visibleSessions = loadedThreadId === threadId ? sessions : [];
  const unsealedSessions = visibleSessions.filter((s) => s.status === 'active');
  const activeCatIds = new Set(unsealedSessions.map((s) => s.catId));
  const runningCatIds = new Set(Object.values(activeInvocations).map((invocation) => invocation.catId));
  const unsealedCountByCat = new Map<string, number>();
  for (const session of unsealedSessions) {
    unsealedCountByCat.set(session.catId, (unsealedCountByCat.get(session.catId) ?? 0) + 1);
  }
  const hasMultipleUnsealedRecords = (catId: string) => (unsealedCountByCat.get(catId) ?? 0) > 1;
  const isObservedRunningSession = (session: SessionSummary) =>
    runningCatIds.has(session.catId) && unsealedCountByCat.get(session.catId) === 1;
  const sealedSessions = visibleSessions
    .filter((s) => s.status === 'sealed' || s.status === 'sealing')
    .sort((a, b) => (b.sealedAt ?? b.createdAt) - (a.sealedAt ?? a.createdAt));

  // F201-churn: runtime-tagged retry fragments are authoritative and fold even when there is only
  // one. Untagged legacy `tool_conflict` corpses still require ≥2 before collapsing because they are
  // heuristic-only old data.
  // 砚砚 review P2: require status==='sealed'. requestSeal() writes sealReason while the record is
  // still 'sealing' (async-finalizes to 'sealed' later), so an in-flight sealing 0-msg tool_conflict
  // record must NOT be folded — it still needs its live status + 查看 action visible.
  const isRuntimeTaggedRetryFragment = (s: SessionSummary) => s.runtimeSession?.retryFragment?.kind === 'retry';
  const isLegacyToolConflictRetryCorpse = (s: SessionSummary) => s.sealReason === 'tool_conflict';
  const isRetryCorpse = (s: SessionSummary) => {
    if (s.status !== 'sealed') return false;
    if (s.messageCount !== 0) return false;
    if (isRuntimeTaggedRetryFragment(s)) return true;
    return isLegacyToolConflictRetryCorpse(s);
  };
  const runtimeTaggedRetryFragments = sealedSessions.filter((s) => isRetryCorpse(s) && isRuntimeTaggedRetryFragment(s));
  const legacyToolConflictRetryCorpses = sealedSessions.filter(
    (s) => isRetryCorpse(s) && !isRuntimeTaggedRetryFragment(s),
  );
  const retryCorpses = [
    ...runtimeTaggedRetryFragments,
    ...(legacyToolConflictRetryCorpses.length >= 2 ? legacyToolConflictRetryCorpses : []),
  ];
  const retryCorpseIds = new Set(retryCorpses.map((s) => s.id));
  const collapseRetryCorpses = retryCorpses.length > 0;
  const visibleSealedSessions = collapseRetryCorpses
    ? sealedSessions.filter((s) => !retryCorpseIds.has(s.id))
    : sealedSessions;
  const hasRuntimeTaggedRetryFragments = runtimeTaggedRetryFragments.length > 0;
  const retryCollapseLabel = hasRuntimeTaggedRetryFragments
    ? `${retryCorpses.length} 次重试片段（已折叠 · 各 0 条消息）`
    : `${retryCorpses.length} 次工具冲突重试片段（已折叠 · 各 0 条消息）`;

  // Check if any cat recently had a compact (from hooks)
  const hasRecentCompact = Object.values(catInvocations).some((inv) => inv.sessionSealed);

  const handleRestoreAsCurrent = async (session: SessionSummary) => {
    if (restoringSessionId || runningCatIds.has(session.catId) || hasMultipleUnsealedRecords(session.catId)) return;
    const current = unsealedSessions.find((candidate) => candidate.catId === session.catId);
    if (
      current &&
      !window.confirm(
        `恢复第 ${session.seq + 1} 段会话为当前会话？当前第 ${current.seq + 1} 段会话会被安全封存，消息不会删除。`,
      )
    ) {
      return;
    }
    setActionError(null);
    setRestoringSessionId(session.id);
    try {
      const res = await apiFetch(`/api/sessions/${session.id}/unseal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedActiveSessionId: current?.id ?? null }),
      });
      const message = await restoreFailureMessage(res);
      if (message) {
        setActionError(message);
        return;
      }
      setRefreshKey((k) => k + 1);
    } catch {
      setActionError('恢复请求失败');
    } finally {
      setRestoringSessionId(null);
    }
  };

  const handleSeal = async (sessionId: string) => {
    if (sealingSessionId) return;
    setActionError(null);
    setSealingSessionId(sessionId);
    try {
      const res = await apiFetch(`/api/sessions/${sessionId}/seal`, { method: 'POST' });
      if (!res.ok) {
        let message = `封存失败 (${res.status})`;
        try {
          const data = (await res.json()) as { error?: string };
          if (data?.error) message = data.error;
        } catch {
          /* best-effort */
        }
        setActionError(message);
        // A non-2xx seal response can still report a completed state transition
        // (for example SESSION_SEAL_PARTIAL), so reconcile with the authoritative chain.
        setRefreshKey((key) => key + 1);
        return;
      }
      setRefreshKey((key) => key + 1);
    } catch {
      setActionError('封存请求失败');
      // A transport failure is ambiguous: the server may have claimed and sealed
      // the session before the connection dropped. Reconcile with the
      // authoritative chain rather than leaving an actionable stale card.
      setRefreshKey((key) => key + 1);
    } finally {
      setSealingSessionId(null);
    }
  };

  const handleNativeCompact = async (session: SessionSummary) => {
    if (
      compactingSessionId ||
      !session.cliSessionId ||
      runningCatIds.has(session.catId) ||
      hasMultipleUnsealedRecords(session.catId)
    )
      return;
    setActionError(null);
    setCompactingSessionId(session.id);
    try {
      const response = await apiFetch(`/api/threads/${threadId}/sessions/${session.catId}/compact-native`, {
        method: 'POST',
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setActionError(body.error ?? `原生压缩失败 (${response.status})`);
        return;
      }
      setRefreshKey((key) => key + 1);
    } catch {
      setActionError('原生压缩请求失败');
    } finally {
      setCompactingSessionId(null);
    }
  };

  return (
    <section className={`${settingsResourceCardClass} p-2.5`}>
      <button
        type="button"
        onClick={() => setChainCollapsed((c) => !c)}
        className="mb-2 flex w-full items-center justify-between"
      >
        <div className="flex items-center gap-1.5">
          <span
            className="text-micro text-cafe-muted transition-transform duration-150"
            style={{ transform: chainCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}
          >
            ▾
          </span>
          <h3 className="text-xs font-bold text-cafe">会话记录</h3>
        </div>
        <span className="text-micro font-bold text-cafe-muted">
          {loadError?.kind === 'access_denied' && visibleSessions.length === 0
            ? '不可用'
            : `${unsealedSessions.length} 未封存 · ${visibleSessions.length} 总计`}
        </span>
      </button>
      {loadError && (
        <div
          data-testid={loadError.kind === 'access_denied' ? 'session-chain-access-denied' : 'session-chain-load-failed'}
          className="mb-2 rounded border border-conn-red-ring bg-conn-red-bg px-2 py-1 text-micro text-conn-red-text"
        >
          {loadError.message}
        </div>
      )}
      {actionError && (
        <div className="mb-2 rounded border border-conn-red-ring bg-conn-red-bg px-2 py-1 text-micro text-conn-red-text">
          {actionError}
        </div>
      )}

      {/* Post-compact safety alert */}
      {hasRecentCompact && (
        <div className="mb-2 px-2 py-1.5 rounded bg-conn-amber-bg border border-conn-amber-ring">
          <div className="flex items-center gap-1.5">
            <span className="text-conn-amber-text text-xs">&#9888;</span>
            <span className="text-micro font-medium text-conn-amber-text">压缩后安全保护中</span>
          </div>
          <p className="text-micro text-conn-amber-text mt-0.5 ml-4">上下文压缩后，高风险操作可能被拦截</p>
        </div>
      )}

      {/* Current unsealed sessions. Storage status "active" does not imply live execution. */}
      {!chainCollapsed &&
        unsealedSessions.map((session) => {
          const inv = catInvocations[session.catId];
          const multipleUnsealedRecords = hasMultipleUnsealedRecords(session.catId);
          const lifecycle = unsealedSessionLifecycle(isObservedRunningSession(session), multipleUnsealedRecords);
          const health: ContextHealthData | undefined =
            (isObservedRunningSession(session) ? inv?.contextHealth : undefined) ??
            (session.contextHealth
              ? {
                  ...session.contextHealth,
                  measuredAt: session.createdAt,
                }
              : undefined);
          // Prefer live invocation usage, fallback to persisted session usage
          const usage = (isObservedRunningSession(session) ? inv?.usage : undefined) ?? session.lastUsage;
          const cachePct = cachePercent(usage?.cacheReadTokens, usage?.inputTokens);
          const invocationIsActive = runningCatIds.has(session.catId);

          const colors = colorsForCat(session.catId);

          return (
            <div key={session.id} className="mb-2">
              <div className="flex items-center gap-1 mb-1">
                <span className={`inline-block h-1.5 w-1.5 rounded-full ${lifecycle.dotClass}`} />
                <span className={`text-micro font-bold ${lifecycle.labelClass}`}>{lifecycle.label}</span>
              </div>
              <div
                data-testid="session-card-active"
                data-cat-id={session.catId}
                data-session-lifecycle={lifecycle.kind}
                className="console-list-card session-corner-arcs rounded-xl p-2.5"
                style={{ boxShadow: colors.cardShadow }}
              >
                <div className="flex items-center justify-between gap-1 mb-1 min-w-0">
                  <div className="flex items-center gap-1.5 min-w-0 overflow-hidden">
                    <span className="shrink-0 text-xs font-semibold text-cafe">第 {session.seq + 1} 段会话</span>
                    <SessionIdTag id={session.cliSessionId ?? session.id} />
                  </div>
                  <span
                    data-testid="session-badge-active"
                    data-cat-id={session.catId}
                    className="shrink min-w-[5ch] truncate text-micro px-1.5 py-0.5 rounded-full font-medium"
                    style={{ backgroundColor: colors.badgeBg, color: colors.badgeText }}
                    title={labelForCat(session.catId)}
                  >
                    {labelForCat(session.catId)}
                  </span>
                </div>
                <div className="text-micro text-cafe-muted mb-1.5">
                  {timeAgo(session.createdAt)}开始
                  {session.messageCount > 0 ? ` · ${session.messageCount} 条消息` : ''}
                  {session.compressionCount != null && session.compressionCount > 0 && (
                    <span className="text-conn-amber-text"> · 压缩 {session.compressionCount} 次</span>
                  )}
                  {session.compressionCount == null && <span className="text-cafe-muted"> · 压缩次数未报告</span>}
                  {session.compressionCount === 0 && <span className="text-cafe-muted"> · 未观察到压缩</span>}
                </div>
                {session.runtimeSession && (
                  <div
                    data-testid="runtime-session-summary"
                    className="mb-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-micro text-cafe-muted"
                  >
                    <span>运行会话</span>
                    <SessionIdTag id={session.runtimeSession.runtimeSessionId} />
                    <span>{session.runtimeSession.runtime}</span>
                    <span>{runtimeLifecycleLabel(session.runtimeSession.lifecycleState)}</span>
                    {session.runtimeSession.runtimeConversationId && (
                      <SessionIdTag id={session.runtimeSession.runtimeConversationId} label="运行对话 ID" />
                    )}
                  </div>
                )}
                {session.runtimeSession?.unexpectedRuntimeSessionSwitch && (
                  <div
                    data-testid="runtime-session-warning"
                    className="mb-1 rounded border border-conn-amber-ring bg-conn-amber-bg px-2 py-1 text-micro text-conn-amber-text"
                  >
                    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                      <span className="font-medium">运行会话意外切换</span>
                      <SessionIdTag
                        id={session.runtimeSession.unexpectedRuntimeSessionSwitch.previousRuntimeSessionId}
                      />
                      <span>-&gt;</span>
                      <SessionIdTag
                        id={session.runtimeSession.unexpectedRuntimeSessionSwitch.currentRuntimeSessionId}
                      />
                    </div>
                  </div>
                )}
                {/* Token counts + cache: prefer live invocation, fallback to persisted */}
                {usage && (usage.inputTokens != null || usage.outputTokens != null) && (
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-micro font-mono mb-1">
                    {usage.inputTokens != null && (
                      <span
                        className="text-cafe-secondary"
                        title="Input tokens reported for this invocation; may include multiple model calls and can reset after CLI compression/session changes. Not necessarily context fill."
                      >
                        {fmtTokens(usage.inputTokens)}
                        <span className="text-cafe-muted ml-0.5">↓</span>
                      </span>
                    )}
                    {usage.outputTokens != null && (
                      <span className="text-cafe-secondary">
                        {fmtTokens(usage.outputTokens)}
                        <span className="text-cafe-muted ml-0.5">↑</span>
                      </span>
                    )}
                    {cachePct > 0 && <span className="text-conn-emerald-text">缓存命中 {cachePct}%</span>}
                  </div>
                )}
                {/* Context health bar (already shows % internally, no duplicate text) */}
                {health && <ContextHealthBar catId={session.catId} health={health} />}
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  {session.cliSessionId && (
                    <button
                      type="button"
                      data-testid={`compact-native-session-${session.id}`}
                      onClick={() => void handleNativeCompact(session)}
                      disabled={
                        compactingSessionId !== null || isStale || invocationIsActive || multipleUnsealedRecords
                      }
                      title={
                        invocationIsActive
                          ? '请先停止该 Agent，再压缩原生上下文'
                          : multipleUnsealedRecords
                            ? '有多条未封存记录，请先核对目标会话'
                            : '请求 provider 原生压缩并保留 Clowder AI continuity'
                      }
                      className="rounded border border-cafe-subtle px-2 py-0.5 text-micro text-cafe-secondary hover:bg-cafe-surface-elevated disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {compactingSessionId === session.id ? '压缩中…' : '原生压缩'}
                    </button>
                  )}
                  <button
                    type="button"
                    data-testid={`seal-session-${session.id}`}
                    className="rounded border border-[var(--_accent-20)] px-2 py-0.5 text-micro text-[var(--color-cafe-accent)] hover:bg-[var(--_accent-5)] disabled:cursor-not-allowed disabled:opacity-50"
                    style={
                      {
                        '--_accent-20': 'color-mix(in oklch, var(--color-cafe-accent) 20%, transparent)',
                        '--_accent-5': 'color-mix(in oklch, var(--color-cafe-accent) 5%, transparent)',
                      } as React.CSSProperties
                    }
                    onClick={() => void handleSeal(session.id)}
                    disabled={sealingSessionId !== null || isStale || invocationIsActive}
                    title={invocationIsActive ? '请先停止该 Agent，再封存会话' : '封存当前会话；下次激活将使用新会话'}
                  >
                    {sealingSessionId === session.id ? '封存中…' : '封存当前会话'}
                  </button>
                </div>
                {(invocationIsActive || multipleUnsealedRecords) && (
                  <p className="mt-1 text-micro text-conn-amber-text">
                    {invocationIsActive
                      ? '正在工作，停止后才能压缩、绑定或封存。'
                      : '多条未封存记录，核对目标后才能压缩或绑定。'}
                  </p>
                )}
                {/* Bind CLI session ID (skip default thread — system-owned, bind returns 403) */}
                {threadId !== 'default' && (
                  <BindSessionInput
                    threadId={threadId}
                    catId={session.catId}
                    onBound={() => setRefreshKey((k) => k + 1)}
                    disabled={isStale || invocationIsActive || multipleUnsealedRecords}
                  />
                )}
              </div>
            </div>
          );
        })}

      {/* Sealed sessions */}
      {sealedSessions.length > 0 && (
        <div className="mt-1">
          <button
            type="button"
            data-testid="sealed-toggle"
            onClick={() => setSealedCollapsed((c) => !c)}
            className="flex w-full items-center gap-1.5 mb-1"
          >
            <span
              className="text-micro text-cafe-muted transition-transform duration-150"
              style={{ transform: sealedCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}
            >
              ▾
            </span>
            <span className="text-micro font-bold text-cafe-muted tracking-wider">已封存</span>
            <span className="text-micro text-cafe-muted">{sealedSessions.length}</span>
          </button>
          {!sealedCollapsed && (
            <div className="space-y-1">
              {visibleSealedSessions.map((session) => {
                const sealedColors = colorsForCat(session.catId);
                const lifecycle = terminalSessionLifecycle(session.status);
                return (
                  <div
                    key={session.id}
                    data-testid="session-card-sealed"
                    data-cat-id={session.catId}
                    data-session-lifecycle={lifecycle.kind}
                    className="console-list-card session-corner-arcs flex items-center gap-2 rounded-xl px-2.5 py-1.5"
                    style={{ boxShadow: sealedColors.cardShadow }}
                  >
                    <div
                      className={`flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center ${
                        session.sealReason?.includes('compact') ? 'bg-conn-amber-bg' : 'bg-cafe-surface-elevated'
                      }`}
                    >
                      <span
                        className={`text-micro ${
                          session.sealReason?.includes('compact') ? 'text-conn-amber-text' : 'text-cafe-muted'
                        }`}
                      >
                        &#128274;
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5 min-w-0 overflow-hidden">
                        <div className="flex max-w-full min-w-0 items-center gap-1.5">
                          <span className="shrink-0 text-xs font-medium text-cafe-secondary">
                            第 {session.seq + 1} 段会话
                          </span>
                          <span
                            data-testid="session-badge-sealed"
                            data-cat-id={session.catId}
                            className="shrink min-w-[5ch] truncate text-micro px-1 py-0.5 rounded-full font-medium"
                            style={{ backgroundColor: sealedColors.badgeBg, color: sealedColors.badgeText }}
                            title={labelForCat(session.catId)}
                          >
                            {labelForCat(session.catId)}
                          </span>
                        </div>
                        <div className="flex min-w-[4rem] flex-1">
                          <SessionIdTag id={session.cliSessionId ?? session.id} />
                        </div>
                      </div>
                      <div data-testid="sealed-session-summary" className="min-w-0">
                        <div className="text-micro font-medium text-cafe-muted">{lifecycle.label}</div>
                        <p className="text-micro text-cafe-muted">{sealedSessionSummary(session)}</p>
                        <p className="text-micro text-cafe-muted">{sealedSessionDetails(session)}</p>
                      </div>
                      {(runningCatIds.has(session.catId) || hasMultipleUnsealedRecords(session.catId)) && (
                        <p className="text-micro text-conn-amber-text">
                          {runningCatIds.has(session.catId)
                            ? '正在工作，停止后才能恢复。'
                            : '多条未封存记录，核对目标后才能恢复。'}
                        </p>
                      )}
                    </div>
                    {(session.status === 'sealed' || session.status === 'sealing') && (
                      <div className="flex shrink-0 items-center gap-1 whitespace-nowrap">
                        {onViewSession && (
                          <button
                            type="button"
                            className="text-micro px-2 py-0.5 rounded border border-[var(--console-border-soft)] text-cafe-secondary hover:bg-cafe-surface-elevated"
                            onClick={() => onViewSession(session.id, session.catId)}
                          >
                            查看
                          </button>
                        )}
                        {/* Session replay entry removed — Phase E AC-E1 sunset.
                            Canonical replay is now Theater Overlay via ThreadItem "回放剧场" (PR E-1). */}
                        {session.status === 'sealed' ? (
                          <button
                            type="button"
                            className="text-micro px-2 py-0.5 rounded border border-[var(--_accent-20)] text-[var(--color-cafe-accent)] hover:bg-[var(--_accent-5)] disabled:opacity-50"
                            style={
                              {
                                '--_accent-20': 'color-mix(in oklch, var(--color-cafe-accent) 20%, transparent)',
                                '--_accent-5': 'color-mix(in oklch, var(--color-cafe-accent) 5%, transparent)',
                              } as React.CSSProperties
                            }
                            onClick={() => {
                              void handleRestoreAsCurrent(session);
                            }}
                            data-testid={`restore-session-${session.id}`}
                            title={
                              runningCatIds.has(session.catId)
                                ? '停止工作后才能恢复为当前'
                                : hasMultipleUnsealedRecords(session.catId)
                                  ? '有多条未封存记录，请先核对当前会话'
                                  : undefined
                            }
                            disabled={
                              restoringSessionId != null ||
                              isStale ||
                              runningCatIds.has(session.catId) ||
                              hasMultipleUnsealedRecords(session.catId)
                            }
                          >
                            {restoringSessionId === session.id ? '恢复中…' : '恢复为当前'}
                          </button>
                        ) : (
                          <span className="text-micro text-cafe-muted">封存中…</span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              {collapseRetryCorpses && (
                <div
                  data-testid="session-card-retry-collapsed"
                  className="console-list-card flex items-center gap-2 rounded-xl px-2.5 py-1.5 opacity-70"
                >
                  <span className="flex-shrink-0 text-micro text-cafe-muted">&#8635;</span>
                  <span className="flex-1 min-w-0 truncate text-micro text-cafe-muted">{retryCollapseLabel}</span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* External conversation/session bindings (skip default thread — system-owned routes return 403). */}
      {!chainCollapsed && threadId !== 'default' && loadError?.kind !== 'access_denied' && (
        <>
          <CloudConversationLink threadId={threadId} />
          <BindNewSessionSection
            threadId={threadId}
            activeCatIds={activeCatIds}
            onBound={() => setRefreshKey((k) => k + 1)}
            disabled={isStale}
          />
        </>
      )}

      {loading && visibleSessions.length === 0 && (
        <div className="text-micro text-cafe-muted text-center py-2">正在读取会话…</div>
      )}
    </section>
  );
}
