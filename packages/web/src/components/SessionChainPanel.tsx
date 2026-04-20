'use client';

// biome-ignore lint/correctness/noUnusedImports: React needed for JSX in vitest environment
import React, { useEffect, useState } from 'react';
import type { CatInvocationInfo, ContextHealthData } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';
import { BindNewSessionSection } from './BindNewSessionSection';
import { ContextHealthBar } from './ContextHealthBar';
import { BindSessionInput, SessionIdTag } from './SessionChainInputs';

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

const CAT_SESSION_COLORS: Record<string, { border: string; badgeBg: string; badgeText: string }> = {
  opus: { border: 'border-opus-primary/40', badgeBg: 'bg-opus-light', badgeText: 'text-opus-dark' },
  codex: { border: 'border-codex-primary/40', badgeBg: 'bg-codex-light', badgeText: 'text-codex-dark' },
  gemini: { border: 'border-gemini-primary/40', badgeBg: 'bg-gemini-light', badgeText: 'text-gemini-dark' },
  kimi: { border: 'border-kimi-primary/40', badgeBg: 'bg-kimi-light', badgeText: 'text-kimi-dark' },
  dare: { border: 'border-dare-primary/40', badgeBg: 'bg-dare-light', badgeText: 'text-dare-dark' },
  // Maine-coon variants: green family, different shades
  gpt52: { border: 'border-[#66BB6A66]', badgeBg: 'bg-[#C8E6C9]', badgeText: 'text-[#2E7D32]' },
  // Ragdoll variants: purple family, different shades
  'opus-45': { border: 'border-[#7E57C266]', badgeBg: 'bg-[#E1D5F0]', badgeText: 'text-[#5E35B1]' },
  sonnet: { border: 'border-[#B39DDB66]', badgeBg: 'bg-[#EDE7F6]', badgeText: 'text-[#6A1B9A]' },
};

const DEFAULT_SESSION_COLORS = { border: 'border-cafe/40', badgeBg: 'bg-gray-200', badgeText: 'text-cafe-secondary' };

export function SessionChainPanel({ threadId, catInvocations, onViewSession }: SessionChainPanelProps) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadedThreadId, setLoadedThreadId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [unsealingSessionId, setUnsealingSessionId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

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
    <section className="rounded-lg border border-cafe bg-cafe-surface-elevated/70 p-3">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-semibold text-cafe-secondary">Session Chain</h3>
        <span className="text-[10px] text-cafe-muted">
          {sessions.length} session{sessions.length !== 1 ? 's' : ''}
        </span>
      </div>

      {actionError && (
        <div className="mb-2 rounded border border-red-200 bg-red-50 px-2 py-1 text-[10px] text-red-700">
          {actionError}
        </div>
      )}

      {/* Post-compact safety alert */}
      {hasRecentCompact && (
        <div className="mb-2 px-2 py-1.5 rounded bg-amber-50 border border-amber-200">
          <div className="flex items-center gap-1.5">
            <span className="text-amber-600 text-xs">&#9888;</span>
            <span className="text-[10px] font-medium text-amber-700">Post-compact safety active</span>
          </div>
          <p className="text-[9px] text-amber-600 mt-0.5 ml-4">
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

        const colors = CAT_SESSION_COLORS[session.catId] ?? DEFAULT_SESSION_COLORS;

        return (
          <div key={session.id} className="mb-2">
            <div className="flex items-center gap-1 mb-1">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-green-500" />
              <span className="text-[9px] font-bold text-green-600 uppercase tracking-wider">Active</span>
            </div>
            <div className={`rounded-md border-[1.5px] ${colors.border} bg-cafe-surface p-2.5 shadow-sm`}>
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-semibold text-cafe">Session #{session.seq + 1}</span>
                  <SessionIdTag id={session.cliSessionId ?? session.id} />
                </div>
                <span
                  className={`text-[9px] px-1.5 py-0.5 rounded-full ${colors.badgeBg} ${colors.badgeText} font-medium`}
                >
                  {session.catId}
                </span>
              </div>
              <div className="text-[10px] text-cafe-muted mb-1.5">
                Started {timeAgo(session.createdAt)}
                {session.messageCount > 0 ? ` · ${session.messageCount} msgs` : ''}
                {(session.compressionCount ?? 0) > 0 && (
                  <span className="text-amber-500"> · {session.compressionCount} compress</span>
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
                  {cachePct > 0 && <span className="text-green-600">cached {cachePct}%</span>}
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
              const sealedColors = CAT_SESSION_COLORS[session.catId] ?? DEFAULT_SESSION_COLORS;
              return (
                <div
                  key={session.id}
                  className={`flex items-center gap-2 rounded border ${sealedColors.border} bg-cafe-surface px-2.5 py-1.5`}
                >
                  <div
                    className={`flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center ${
                      session.sealReason?.includes('compact') ? 'bg-amber-100' : 'bg-cafe-surface-elevated'
                    }`}
                  >
                    <span
                      className={`text-[10px] ${
                        session.sealReason?.includes('compact') ? 'text-amber-500' : 'text-cafe-muted'
                      }`}
                    >
                      &#128274;
                    </span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] font-medium text-cafe-secondary">Session #{session.seq + 1}</span>
                      <span
                        className={`text-[9px] px-1 py-0.5 rounded-full ${sealedColors.badgeBg} ${sealedColors.badgeText} font-medium`}
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
                          className="text-[10px] px-2 py-0.5 rounded border border-cafe text-cafe-secondary hover:bg-cafe-surface-elevated"
                          onClick={() => onViewSession(session.id, session.catId)}
                        >
                          查看
                        </button>
                      )}
                      <button
                        type="button"
                        className="text-[10px] px-2 py-0.5 rounded border border-blue-200 text-blue-600 hover:bg-blue-50 disabled:opacity-50"
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
