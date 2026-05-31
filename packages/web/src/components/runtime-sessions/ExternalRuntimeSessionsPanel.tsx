'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import {
  formatBindingLabel,
  formatLifecycleBadge,
  formatRuntimeLabel,
  formatRuntimeSessionTitle,
  formatSealReason,
  formatSurfaceBadge,
  shortRuntimeId,
} from './external-runtime-session-format';
import type {
  ExternalRuntimeSessionListItem,
  ExternalRuntimeSessionsListResponse,
} from './external-runtime-session-types';

type RuntimeSessionStatusFilter = 'all' | 'active' | 'sealed' | 'attention';

export interface ExternalRuntimeSessionsPanelProps {
  limit?: number;
  onViewSession?: (sessionId: string, catId?: string) => void;
  className?: string;
  initialStatusFilter?: RuntimeSessionStatusFilter;
}

const STATUS_FILTERS: Array<{ key: RuntimeSessionStatusFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'active', label: '进行' },
  { key: 'sealed', label: '封存' },
  { key: 'attention', label: '关注' },
];

export function ExternalRuntimeSessionsPanel({
  limit = 20,
  onViewSession,
  className = '',
  initialStatusFilter = 'all',
}: ExternalRuntimeSessionsPanelProps) {
  const [sessions, setSessions] = useState<ExternalRuntimeSessionListItem[]>([]);
  const [statusFilter, setStatusFilter] = useState<RuntimeSessionStatusFilter>(initialStatusFilter);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/external-runtime-sessions?runtime=antigravity-desktop&limit=${limit}`);
      if (!res.ok) {
        const body = (await readJsonSafe(res)) as { error?: string };
        setError(body.error ?? `加载失败 (${res.status})`);
        return;
      }
      const body = (await res.json()) as ExternalRuntimeSessionsListResponse;
      setSessions(Array.isArray(body.sessions) ? body.sessions : []);
    } catch {
      setError('网络错误，无法加载 runtime sessions');
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const visibleSessions = useMemo(
    () => sessions.filter((session) => sessionMatchesFilter(session, statusFilter)),
    [sessions, statusFilter],
  );

  return (
    <section className={`min-w-0 space-y-3 ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-cafe-text">{formatRuntimeLabel('antigravity-desktop')}</h2>
          <p className="text-micro text-cafe-muted">Runtime sessions（Café 派发 + IDE 直连）</p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className="h-8 shrink-0 rounded-lg bg-cafe-accent px-3 text-xs font-semibold text-[var(--cafe-surface)] transition-colors hover:bg-cafe-accent-hover disabled:opacity-50"
        >
          刷新
        </button>
      </div>

      <div className="flex w-full max-w-sm overflow-hidden rounded-lg border border-[var(--console-border-soft)]">
        {STATUS_FILTERS.map((filter) => {
          const active = filter.key === statusFilter;
          return (
            <button
              key={filter.key}
              type="button"
              onClick={() => setStatusFilter(filter.key)}
              className={`h-8 flex-1 px-2 text-xs font-semibold transition-colors ${
                active
                  ? 'bg-[var(--console-button-emphasis)] text-[var(--cafe-surface)]'
                  : 'bg-transparent text-cafe-muted hover:bg-[var(--console-hover-bg)] hover:text-cafe-secondary'
              }`}
            >
              {filter.label}
            </button>
          );
        })}
      </div>

      {error && (
        <div className="rounded-lg bg-conn-red-bg px-3 py-2 text-xs text-conn-red-text" data-testid="runtime-error">
          {error}
        </div>
      )}

      {loading && sessions.length === 0 && <div className="py-5 text-center text-xs text-cafe-muted">加载中...</div>}

      {!loading && !error && visibleSessions.length === 0 && (
        <div className="rounded-lg border border-dashed border-[var(--console-border-soft)] py-8 text-center text-xs text-cafe-muted">
          没有 runtime 会话
        </div>
      )}

      {visibleSessions.length > 0 && (
        <ul className="min-w-0 divide-y divide-[var(--console-border-soft)] overflow-hidden rounded-lg border border-[var(--console-border-soft)]">
          {visibleSessions.map((session) => (
            <RuntimeSessionRow key={session.sessionId} session={session} onViewSession={onViewSession} />
          ))}
        </ul>
      )}
    </section>
  );
}

function RuntimeSessionRow({
  session,
  onViewSession,
}: {
  session: ExternalRuntimeSessionListItem;
  onViewSession?: (sessionId: string, catId?: string) => void;
}) {
  const badge = formatLifecycleBadge(session.lifecycle);
  const sealReason = formatSealReason(session.lifecycle.sealReason);
  const surfaceBadge = formatSurfaceBadge(session.surface);
  return (
    <li className="min-w-0 bg-[var(--console-card-bg)] px-3 py-2" data-testid="runtime-session-row">
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className={`rounded-md px-1.5 py-0.5 text-micro font-semibold ${badge.className}`}>
              {badge.label}
            </span>
            {surfaceBadge && (
              <span className={`rounded-md px-1.5 py-0.5 text-micro font-semibold ${surfaceBadge.className}`}>
                {surfaceBadge.label}
              </span>
            )}
            {session.lifecycle.sealReason && <span className="text-micro text-cafe-muted">{sealReason}</span>}
            <span className="min-w-0 truncate text-xs font-semibold text-cafe-text">
              {formatRuntimeSessionTitle(session)}
            </span>
          </div>
          <div className="grid min-w-0 gap-x-4 gap-y-1 text-micro text-cafe-muted sm:grid-cols-2">
            <span className="min-w-0 truncate">
              {session.catId} · {session.model ?? 'model unknown'}
            </span>
            <span className="min-w-0 truncate font-mono">{shortRuntimeId(session.runtimeSessionId)}</span>
            {session.runtimeConversationId && (
              <span className="min-w-0 truncate font-mono">{session.runtimeConversationId}</span>
            )}
            <span className="min-w-0 truncate">
              {formatBindingLabel(session.binding)} · {formatTimestamp(session.lastObservedAt)}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => onViewSession?.(session.sessionId, session.catId)}
          className="h-8 w-14 self-center rounded-lg bg-[var(--console-card-bg)] text-xs font-semibold text-cafe-secondary shadow-[0_1px_3px_rgba(43,33,26,0.06)] transition-colors hover:bg-[var(--console-hover-bg)] hover:text-cafe"
        >
          查看
        </button>
      </div>
    </li>
  );
}

function sessionMatchesFilter(session: ExternalRuntimeSessionListItem, filter: RuntimeSessionStatusFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'active') return session.lifecycle.state === 'active';
  if (filter === 'sealed') return session.lifecycle.state === 'sealed';
  return session.lifecycle.state === 'runtime_seal_pending' || session.lifecycle.state === 'runtime_conflict_pending';
}

function formatTimestamp(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return '—';
  return new Date(timestamp).toLocaleString();
}

async function readJsonSafe(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}
