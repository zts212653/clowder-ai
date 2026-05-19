'use client';

// F198 Phase C AC-C4: Hub Oversight deep-dive — lists active daemon bg carrier sessions
// from ~/.claude/jobs/<shortId>/state.json via GET /api/agent-sessions.

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

interface AgentSessionSnapshot {
  daemonShortId: string;
  state: string;
  detail?: string;
  cwd?: string;
  createdAt?: string;
  updatedAt?: string;
}

function formatTs(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return iso;
  }
}

function stateColor(state: string): string {
  if (state === 'done') return 'text-green-400';
  if (state === 'error' || state === 'failed') return 'text-conn-red-text';
  if (state === 'working') return 'text-amber-400 animate-pulse';
  return 'text-cafe-muted';
}

export function HubAgentSessionsTab() {
  const [sessions, setSessions] = useState<AgentSessionSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // AC-C5: 接管 overlay per session — shows `claude attach <shortId>` command
  const [attachOverlay, setAttachOverlay] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopy = useCallback(async (shortId: string) => {
    try {
      await navigator.clipboard.writeText(`claude attach ${shortId}`);
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard not available — command still visible to type manually
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/agent-sessions');
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        setError(body.error ?? `加载失败 (${res.status})`);
        return;
      }
      const data = (await res.json()) as AgentSessionSnapshot[];
      setSessions(data);
    } catch {
      setError('网络错误，无法加载后台会话');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-cafe-text">后台 Daemon 会话</h2>
        <button
          onClick={() => void refresh()}
          disabled={loading}
          className="text-xs px-2 py-1 rounded bg-cafe-surface hover:bg-cafe-surface-hover text-cafe-text disabled:opacity-50"
        >
          {loading ? '加载中…' : '刷新'}
        </button>
      </div>

      {error && <div className="text-xs text-conn-red-text bg-red-950/30 rounded p-2">{error}</div>}

      {!loading && sessions.length === 0 && !error && (
        <div className="text-xs text-cafe-muted text-center py-8">没有找到后台会话 (当前 ~/.claude/jobs/ 为空)</div>
      )}

      {sessions.length > 0 && (
        <div className="space-y-2">
          {sessions.map((s) => (
            <div key={s.daemonShortId} className="rounded border border-cafe-border bg-cafe-surface p-3 space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs text-cafe-text">{s.daemonShortId}</span>
                <div className="flex items-center gap-2">
                  <span className={`text-xs font-medium ${stateColor(s.state)}`}>{s.state}</span>
                  {/* AC-C5: takeover entry — opens attach command overlay */}
                  <button
                    type="button"
                    onClick={() => setAttachOverlay(attachOverlay === s.daemonShortId ? null : s.daemonShortId)}
                    className="text-[10px] px-1.5 py-0.5 rounded border border-cafe-border text-cafe-muted hover:text-cafe-text hover:border-cafe-text transition-colors"
                  >
                    接管
                  </button>
                </div>
              </div>
              {s.detail && <div className="text-xs text-cafe-muted truncate">{s.detail}</div>}
              {s.cwd && <div className="text-xs text-cafe-muted truncate font-mono">{s.cwd}</div>}
              <div className="flex gap-4 text-[10px] text-cafe-muted">
                {s.createdAt && <span>创建 {formatTs(s.createdAt)}</span>}
                {s.updatedAt && <span>更新 {formatTs(s.updatedAt)}</span>}
              </div>
              {/* AC-C5: attach command overlay — daemon 的接管路径是 claude attach */}
              {attachOverlay === s.daemonShortId && (
                <div className="flex items-center gap-2 rounded bg-cafe-surface-elevated px-2 py-1.5 mt-1">
                  <code className="flex-1 text-xs font-mono text-cafe-text select-all">
                    claude attach {s.daemonShortId}
                  </code>
                  <button
                    type="button"
                    onClick={() => void handleCopy(s.daemonShortId)}
                    className="text-[10px] px-1.5 py-0.5 rounded bg-cafe-surface text-cafe-muted hover:text-cafe-text transition-colors flex-shrink-0"
                  >
                    {copied ? '已复制 ✓' : '复制'}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
