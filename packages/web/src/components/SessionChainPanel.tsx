'use client';

// biome-ignore lint/correctness/noUnusedImports: React needed for JSX in vitest environment
import React, { useEffect, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import type { CatInvocationInfo, ContextHealthData } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';
import { BindNewSessionSection } from './BindNewSessionSection';
import { ContextHealthBar } from './ContextHealthBar';
import { BindSessionInput, SessionIdTag } from './SessionChainInputs';
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
  compressionCount?: number;
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
}

const sessionCache = new Map<string, SessionSummary[]>();

export function __resetSessionChainCacheForTest() {
  sessionCache.clear();
}

export interface SessionChainPanelProps {
  threadId: string;
  catInvocations: Record<string, CatInvocationInfo>;
  onViewSession?: (sessionId: string, catId?: string) => void;
}

function timeAgo(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ago`;
}

function sealReasonLabel(reason?: string): string {
  if (!reason) return '';
  if (reason.includes('compact')) return 'compact';
  if (reason === 'threshold') return 'threshold';
  if (reason === 'budget_exhausted') return 'budget';
  if (reason === 'max_compressions') return 'max compress';
  if (reason === 'manual') return 'manual';
  if (reason === 'cli_session_replaced') return 'CLI replaced';
  if (reason === 'overflow_circuit_breaker') return 'overflow';
  if (reason === 'unseal_displacement') return 'unseal displaced';
  if (reason === 'reconcile_stuck') return 'stuck reaper';
  if (reason === 'global_reaper') return 'global reaper';
  if (reason === 'turn_budget_exceeded') return 'budget exceeded';
  if (reason === 'lease_timeout') return 'lease timeout'; // legacy
  return reason;
}

function cachePercent(cacheRead?: number, input?: number): number {
  if (!cacheRead || !input) return 0;
  return Math.round((cacheRead / input) * 100);
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

export function SessionChainPanel({ threadId, catInvocations, onViewSession }: SessionChainPanelProps) {
  const { getCatById } = useCatData();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadedThreadId, setLoadedThreadId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [unsealingSessionId, setUnsealingSessionId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const colorsForCat = (catId: string): SessionColors => {
    const cat = getCatById(catId);
    return deriveSessionColors(cat?.color?.primary, cat?.color?.secondary);
  };

  // Data is stale when it belongs to a different thread than the one we're viewing
  const isStale = loadedThreadId !== threadId;

  // Re-fetch when any cat's sessionSealed changes
  const sealSignal = Object.values(catInvocations)
    .map((inv) => `${inv.sessionSeq ?? ''}:${inv.sessionSealed ?? ''}`)
    .join(',');

  // Fetch sessions — stale-while-revalidate: keep old data visible until
  // the new response arrives, preventing blank flashes on thread switch / F5.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sealSignal+refreshKey intentionally trigger re-fetch
  useEffect(() => {
    let cancelled = false;
    const cached = sessionCache.get(threadId);
    if (cached) {
      setSessions(cached);
      setLoadedThreadId(threadId);
    }
    setLoading(true);
    apiFetch(`/api/threads/${threadId}/sessions`)
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) return;
        const data = (await res.json()) as { sessions: SessionSummary[] };
        if (!cancelled) {
          sessionCache.set(threadId, data.sessions);
          setSessions(data.sessions);
          setLoadedThreadId(threadId);
        }
      })
      .catch(() => {
        // Keep stale data visible on transient errors
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [threadId, sealSignal, refreshKey]);

  const activeSessions = sessions.filter((s) => s.status === 'active');
  const activeCatIds = new Set(activeSessions.map((s) => s.catId));
  const sealedSessions = sessions
    .filter((s) => s.status === 'sealed' || s.status === 'sealing')
    .sort((a, b) => (b.sealedAt ?? b.createdAt) - (a.sealedAt ?? a.createdAt));

  // Check if any cat recently had a compact (from hooks)
  const hasRecentCompact = Object.values(catInvocations).some((inv) => inv.sessionSealed);

  const handleUnseal = async (sessionId: string) => {
    if (unsealingSessionId) return;
    setActionError(null);
    setUnsealingSessionId(sessionId);
    try {
      const res = await apiFetch(`/api/sessions/${sessionId}/unseal`, { method: 'POST' });
      if (!res.ok) {
        let message = `Unseal failed (${res.status})`;
        try {
          const data = (await res.json()) as { error?: string };
          if (data?.error) message = data.error;
        } catch {
          /* best-effort */
        }
        setActionError(message);
        return;
      }
      setRefreshKey((k) => k + 1);
    } catch {
      setActionError('Unseal request failed');
    } finally {
      setUnsealingSessionId(null);
    }
  };

  return (
    <section className="rounded-[10px] bg-[var(--console-card-bg)] p-[9px]">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[11px] font-bold text-cafe-secondary">Session Chain</h3>
        <span className="text-[8px] font-bold text-cafe-muted">
          {sessions.length} session{sessions.length !== 1 ? 's' : ''}
        </span>
      </div>

      {actionError && (
        <div className="mb-2 rounded border border-conn-red-ring bg-conn-red-bg px-2 py-1 text-[10px] text-conn-red-text">
          {actionError}
        </div>
      )}

      {/* Post-compact safety alert */}
      {hasRecentCompact && (
        <div className="mb-2 px-2 py-1.5 rounded bg-conn-amber-bg border border-conn-amber-ring">
          <div className="flex items-center gap-1.5">
            <span className="text-conn-amber-text text-xs">&#9888;</span>
            <span className="text-[10px] font-medium text-conn-amber-text">Post-compact safety active</span>
          </div>
          <p className="text-[9px] text-conn-amber-text mt-0.5 ml-4">
            High-risk ops may be blocked after context compression
          </p>
        </div>
      )}

      {/* Active sessions */}
      {activeSessions.map((session) => {
        const inv = catInvocations[session.catId];
        const health: ContextHealthData | undefined =
          inv?.contextHealth ??
          (session.contextHealth
            ? {
                ...session.contextHealth,
                measuredAt: session.createdAt,
              }
            : undefined);
        // Prefer live invocation usage, fallback to persisted session usage
        const usage = inv?.usage ?? session.lastUsage;
        const cachePct = cachePercent(usage?.cacheReadTokens, usage?.inputTokens);

        const colors = colorsForCat(session.catId);

        return (
          <div key={session.id} className="mb-2">
            <div className="flex items-center gap-1 mb-1">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-conn-emerald-text)]" />
              <span className="text-[9px] font-bold text-conn-emerald-text uppercase tracking-wider">Active</span>
            </div>
            <div
              data-testid="session-card-active"
              data-cat-id={session.catId}
              className="rounded-md bg-[var(--console-card-soft-bg)] p-2.5"
              style={{ boxShadow: `inset 3px 0 0 ${colors.border}` }}
            >
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-semibold text-cafe">Session #{session.seq + 1}</span>
                  <SessionIdTag id={session.cliSessionId ?? session.id} />
                </div>
                <span
                  data-testid="session-badge-active"
                  data-cat-id={session.catId}
                  className="text-[9px] px-1.5 py-0.5 rounded-full font-medium"
                  style={{ backgroundColor: colors.badgeBg, color: colors.badgeText }}
                >
                  {session.catId}
                </span>
              </div>
              <div className="text-[10px] text-cafe-muted mb-1.5">
                Started {timeAgo(session.createdAt)}
                {session.messageCount > 0 ? ` · ${session.messageCount} msgs` : ''}
                {(session.compressionCount ?? 0) > 0 && (
                  <span className="text-conn-amber-text"> · {session.compressionCount} compress</span>
                )}
              </div>
              {/* Token counts + cache: prefer live invocation, fallback to persisted */}
              {usage && (usage.inputTokens != null || usage.outputTokens != null) && (
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[10px] font-mono mb-1">
                  {usage.inputTokens != null && (
                    <span className="text-cafe-secondary">
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
                  {cachePct > 0 && <span className="text-conn-emerald-text">cached {cachePct}%</span>}
                </div>
              )}
              {/* Context health bar (already shows % internally, no duplicate text) */}
              {health && <ContextHealthBar catId={session.catId} health={health} />}
              {/* Bind CLI session ID (skip default thread — system-owned, bind returns 403) */}
              {threadId !== 'default' && (
                <BindSessionInput
                  threadId={threadId}
                  catId={session.catId}
                  onBound={() => setRefreshKey((k) => k + 1)}
                  disabled={isStale}
                />
              )}
            </div>
          </div>
        );
      })}

      {/* Sealed sessions */}
      {sealedSessions.length > 0 && (
        <div className="mt-1">
          <div className="flex items-center gap-1 mb-1">
            <span className="text-[9px] font-bold text-cafe-muted uppercase tracking-wider">Sealed</span>
          </div>
          <div className="space-y-1">
            {sealedSessions.map((session) => {
              const sealedColors = colorsForCat(session.catId);
              return (
                <div
                  key={session.id}
                  data-testid="session-card-sealed"
                  data-cat-id={session.catId}
                  className="flex items-center gap-2 rounded bg-[var(--console-card-soft-bg)] px-2.5 py-1.5"
                  style={{ boxShadow: `inset 2px 0 0 ${sealedColors.border}` }}
                >
                  <div
                    className={`flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center ${
                      session.sealReason?.includes('compact') ? 'bg-conn-amber-bg' : 'bg-cafe-surface-elevated'
                    }`}
                  >
                    <span
                      className={`text-[10px] ${
                        session.sealReason?.includes('compact') ? 'text-conn-amber-text' : 'text-cafe-muted'
                      }`}
                    >
                      &#128274;
                    </span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] font-medium text-cafe-secondary">Session #{session.seq + 1}</span>
                      <span
                        data-testid="session-badge-sealed"
                        data-cat-id={session.catId}
                        className="text-[9px] px-1 py-0.5 rounded-full font-medium"
                        style={{ backgroundColor: sealedColors.badgeBg, color: sealedColors.badgeText }}
                      >
                        {session.catId}
                      </span>
                      <SessionIdTag id={session.cliSessionId ?? session.id} />
                    </div>
                    <div className="text-[9px] text-cafe-muted truncate">
                      {session.sealedAt ? timeAgo(session.sealedAt) : 'sealing'}
                      {session.contextHealth ? ` · ${Math.round(session.contextHealth.fillRatio * 100)}%` : ''}
                      {' · '}
                      {session.messageCount} msgs
                      {(session.compressionCount ?? 0) > 0 && ` · ${session.compressionCount} compress`}
                      {session.sealReason ? ` · ${sealReasonLabel(session.sealReason)}` : ''}
                    </div>
                  </div>
                  {(session.status === 'sealed' || session.status === 'sealing') && (
                    <div className="flex items-center gap-1">
                      {onViewSession && (
                        <button
                          type="button"
                          className="text-[10px] px-2 py-0.5 rounded border border-[var(--console-border-soft)] text-cafe-secondary hover:bg-cafe-surface-elevated"
                          onClick={() => onViewSession(session.id, session.catId)}
                        >
                          查看
                        </button>
                      )}
                      <button
                        type="button"
                        className="text-[10px] px-2 py-0.5 rounded border border-[var(--color-cafe-accent)]/20 text-[var(--color-cafe-accent)] hover:bg-[var(--color-cafe-accent)]/5 disabled:opacity-50"
                        onClick={() => {
                          void handleUnseal(session.id);
                        }}
                        disabled={unsealingSessionId != null || isStale}
                      >
                        {unsealingSessionId === session.id ? '解封中…' : '解封'}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* F33: Bind new external session (skip default thread — system-owned, bind returns 403) */}
      {threadId !== 'default' && (
        <BindNewSessionSection
          threadId={threadId}
          activeCatIds={activeCatIds}
          onBound={() => setRefreshKey((k) => k + 1)}
          disabled={isStale}
        />
      )}

      {isStale && sessions.length > 0 && (
        <div className="text-[10px] text-cafe-muted text-center py-1 animate-pulse">Refreshing...</div>
      )}

      {loading && sessions.length === 0 && (
        <div className="text-[10px] text-cafe-muted text-center py-2">Loading sessions...</div>
      )}
    </section>
  );
}
