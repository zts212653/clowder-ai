'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useIMEGuard } from '@/hooks/useIMEGuard';
import { apiFetch } from '@/utils/api-client';

interface SearchHit {
  score: number;
  sessionId: string;
  seq?: number;
  kind: 'digest' | 'event';
  snippet: string;
  pointer: {
    eventNo?: number;
    invocationId?: string;
  };
}

export interface SessionSearchTabProps {
  threadId: string;
  onViewSession?: (sessionId: string, sourceThreadId: string) => void;
  onViewInvocation?: (sessionId: string, invocationId: string, sourceThreadId: string) => void;
}

interface SearchResultSet {
  threadId: string;
  hits: SearchHit[];
}

const KIND_BADGE: Record<string, { bg: string; text: string }> = {
  digest: { bg: 'bg-blue-100', text: 'text-blue-700' },
  event: { bg: 'bg-cafe-surface-elevated', text: 'text-cafe-secondary' },
};

export function SessionSearchTab({ threadId, onViewSession, onViewInvocation }: SessionSearchTabProps) {
  const ime = useIMEGuard();
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<'both' | 'digests' | 'transcripts'>('both');
  const [resultSet, setResultSet] = useState<SearchResultSet | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const activeThreadIdRef = useRef(threadId);
  const requestGenerationRef = useRef(0);
  activeThreadIdRef.current = threadId;

  useEffect(() => {
    requestGenerationRef.current += 1;
    setResultSet(null);
    setLoading(false);
    setError(false);
    return () => {
      requestGenerationRef.current += 1;
    };
  }, [threadId]);

  const doSearch = useCallback(async () => {
    if (!query.trim()) return;
    const requestThreadId = threadId;
    const requestGeneration = requestGenerationRef.current + 1;
    requestGenerationRef.current = requestGeneration;
    const isCurrentRequest = () =>
      activeThreadIdRef.current === requestThreadId && requestGenerationRef.current === requestGeneration;
    setLoading(true);
    setError(false);
    try {
      const q = encodeURIComponent(query.trim());
      const res = await apiFetch(`/api/threads/${requestThreadId}/sessions/search?q=${q}&scope=${scope}`);
      if (!res.ok) {
        if (isCurrentRequest()) setError(true);
        return;
      }
      const data = (await res.json()) as { hits: SearchHit[] };
      if (isCurrentRequest()) setResultSet({ threadId: requestThreadId, hits: data.hits });
    } catch {
      if (isCurrentRequest()) setError(true);
    } finally {
      if (isCurrentRequest()) setLoading(false);
    }
  }, [threadId, query, scope]);

  const visibleResultSet = resultSet?.threadId === threadId ? resultSet : null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    doSearch();
  };

  return (
    <div className="space-y-2">
      <form onSubmit={handleSubmit} className="flex gap-1.5">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onCompositionStart={ime.onCompositionStart}
          onCompositionEnd={ime.onCompositionEnd}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && ime.isComposing()) e.preventDefault();
          }}
          placeholder="搜索 session 内容..."
          className="flex-1 text-xs rounded-[10px] border-transparent bg-[var(--console-field-bg,var(--console-card-bg))] px-2 py-1 focus:outline-none focus:ring-1 focus:ring-cafe-accent"
        />
        <button
          type="submit"
          disabled={loading || !query.trim()}
          className="rounded-lg bg-cafe-accent px-3 py-1.5 text-xs font-semibold text-[var(--cafe-surface)] transition-colors hover:bg-cafe-accent-hover disabled:opacity-50"
        >
          搜索
        </button>
      </form>

      <div className="flex items-center gap-1 text-micro text-cafe-muted">
        <span>范围:</span>
        {(['both', 'transcripts', 'digests'] as const).map((s) => (
          <button
            type="button"
            key={s}
            onClick={() => setScope(s)}
            className={`px-1.5 py-0.5 rounded ${scope === s ? 'bg-conn-blue-bg text-conn-blue-text' : 'hover:bg-cafe-surface-elevated'}`}
          >
            {s === 'both' ? '全部' : s === 'transcripts' ? '对话' : '摘要'}
          </button>
        ))}
      </div>

      {loading && <div className="text-xs text-cafe-muted py-2">搜索中...</div>}
      {error && <div className="text-xs text-conn-red-text py-2">搜索失败</div>}

      {visibleResultSet !== null &&
        !loading &&
        !error &&
        (visibleResultSet.hits.length === 0 ? (
          <div className="text-xs text-cafe-muted py-2">无匹配结果</div>
        ) : (
          <div className="space-y-1.5 max-h-48 overflow-y-auto">
            {visibleResultSet.hits.map((hit, i) => {
              const badge = KIND_BADGE[hit.kind] ?? KIND_BADGE.event;
              return (
                <div
                  key={`${hit.sessionId}-${hit.kind}-${i}`}
                  className="rounded-lg bg-[var(--console-shell-bg)] px-2 py-1.5 hover:bg-cafe-surface-elevated transition-colors"
                >
                  <div className="flex items-center gap-1.5 text-xs">
                    <span className={`px-1 py-0.5 rounded text-micro font-medium ${badge.bg} ${badge.text}`}>
                      {hit.kind}
                    </span>
                    <button
                      type="button"
                      data-testid="search-result-session"
                      onClick={() => {
                        if (hit.pointer.invocationId && onViewInvocation) {
                          onViewInvocation(hit.sessionId, hit.pointer.invocationId, visibleResultSet.threadId);
                        } else {
                          onViewSession?.(hit.sessionId, visibleResultSet.threadId);
                        }
                      }}
                      className="font-mono text-conn-blue-text hover:text-conn-blue-text hover:underline"
                    >
                      {hit.sessionId}
                    </button>
                  </div>
                  <p className="text-xs text-cafe-secondary mt-0.5">{hit.snippet}</p>
                  {hit.pointer.eventNo != null && (
                    <span className="text-micro text-cafe-muted">event #{hit.pointer.eventNo}</span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
    </div>
  );
}
