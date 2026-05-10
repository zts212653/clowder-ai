'use client';

import React, { useCallback, useState } from 'react';
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
  onViewSession?: (sessionId: string) => void;
}

const KIND_BADGE: Record<string, { bg: string; text: string }> = {
  digest: { bg: 'bg-[var(--color-cafe-accent)]/10', text: 'text-[var(--color-cafe-accent)]' },
  event: { bg: 'bg-cafe-surface-elevated', text: 'text-cafe-secondary' },
};

export function SessionSearchTab({ threadId, onViewSession }: SessionSearchTabProps) {
  const ime = useIMEGuard();
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<'both' | 'digests' | 'transcripts'>('both');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const doSearch = useCallback(async () => {
    if (!query.trim()) return;
    setLoading(true);
    setError(false);
    try {
      const q = encodeURIComponent(query.trim());
      const res = await apiFetch(`/api/threads/${threadId}/sessions/search?q=${q}&scope=${scope}`);
      if (!res.ok) {
        setError(true);
        return;
      }
      const data = (await res.json()) as { hits: SearchHit[] };
      setHits(data.hits);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [threadId, query, scope]);

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
          className="flex-1 text-xs border border-[var(--console-border-soft)] rounded px-2 py-1 focus:outline-none focus:border-[var(--color-cafe-accent)]/50"
        />
        <button
          type="submit"
          disabled={loading || !query.trim()}
          className="text-[11px] px-2 py-1 rounded bg-[var(--color-cafe-accent)] text-[var(--cafe-surface)] hover:opacity-90 disabled:opacity-50 transition-colors"
        >
          搜索
        </button>
      </form>

      <div className="flex items-center gap-1 text-[10px] text-cafe-muted">
        <span>范围:</span>
        {(['both', 'transcripts', 'digests'] as const).map((s) => (
          <button
            type="button"
            key={s}
            onClick={() => setScope(s)}
            className={`px-1.5 py-0.5 rounded ${scope === s ? 'bg-[var(--color-cafe-accent)]/10 text-[var(--color-cafe-accent)]' : 'hover:bg-cafe-surface-elevated'}`}
          >
            {s === 'both' ? '全部' : s === 'transcripts' ? '对话' : '摘要'}
          </button>
        ))}
      </div>

      {loading && <div className="text-xs text-cafe-muted py-2">搜索中...</div>}
      {error && <div className="text-xs text-conn-red-text py-2">搜索失败</div>}

      {hits !== null &&
        !loading &&
        !error &&
        (hits.length === 0 ? (
          <div className="text-xs text-cafe-muted py-2">无匹配结果</div>
        ) : (
          <div className="space-y-1.5 max-h-48 overflow-y-auto">
            {hits.map((hit, i) => {
              const badge = KIND_BADGE[hit.kind] ?? KIND_BADGE.event;
              return (
                <div
                  key={`${hit.sessionId}-${hit.kind}-${i}`}
                  className="rounded border border-[var(--console-border-soft)] px-2 py-1.5 hover:bg-cafe-surface-elevated transition-colors"
                >
                  <div className="flex items-center gap-1.5 text-[11px]">
                    <span className={`px-1 py-0.5 rounded text-[9px] font-medium ${badge.bg} ${badge.text}`}>
                      {hit.kind}
                    </span>
                    <button
                      type="button"
                      data-testid="search-result-session"
                      onClick={() => onViewSession?.(hit.sessionId)}
                      className="font-mono text-[var(--color-cafe-accent)] hover:opacity-80 hover:underline"
                    >
                      {hit.sessionId}
                    </button>
                  </div>
                  <p className="text-[11px] text-cafe-secondary mt-0.5">{hit.snippet}</p>
                  {hit.pointer.eventNo != null && (
                    <span className="text-[9px] text-cafe-muted">event #{hit.pointer.eventNo}</span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
    </div>
  );
}
