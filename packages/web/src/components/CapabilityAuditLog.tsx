'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

interface AuditEntry {
  timestamp: string;
  userId: string;
  action: 'install' | 'delete' | 'update' | 'toggle';
  capabilityId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

const ACTION_LABELS: Record<string, { text: string; color: string }> = {
  install: { text: '安装', color: 'text-green-600 bg-green-50' },
  delete: { text: '删除', color: 'text-red-600 bg-red-50' },
  update: { text: '更新', color: 'text-blue-600 bg-blue-50' },
  toggle: { text: '开关', color: 'text-amber-600 bg-amber-50' },
};

export function CapabilityAuditLog({ projectPath }: { projectPath?: string }) {
  const [expanded, setExpanded] = useState(false);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchAudit = useCallback(async () => {
    setLoading(true);
    try {
      const query = new URLSearchParams({ limit: '20' });
      if (projectPath) query.set('projectPath', projectPath);
      const res = await apiFetch(`/api/capabilities/audit?${query}`);
      if (res.ok) {
        const data = (await res.json()) as { entries: AuditEntry[] };
        setEntries(data.entries.reverse());
      }
    } catch {
      // non-critical
    } finally {
      setLoading(false);
    }
  }, [projectPath]);

  useEffect(() => {
    if (expanded) fetchAudit();
  }, [expanded, fetchAudit]);

  return (
    <div className="border-t border-slate-100/60 pt-3 mt-2">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-600 transition-colors"
      >
        <svg
          className={`w-3 h-3 transition-transform ${expanded ? 'rotate-90' : ''}`}
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path
            fillRule="evenodd"
            d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z"
            clipRule="evenodd"
          />
        </svg>
        审计日志
      </button>

      {expanded && (
        <div className="mt-2 max-h-48 overflow-y-auto">
          {loading && <p className="text-xs text-slate-400">加载中...</p>}
          {!loading && entries.length === 0 && <p className="text-xs text-slate-400">暂无记录</p>}
          {entries.map((e, i) => {
            const label = ACTION_LABELS[e.action] ?? { text: e.action, color: 'text-slate-500 bg-slate-50' };
            return (
              <div key={`${e.timestamp}-${i}`} className="flex items-center gap-2 py-1 text-xs">
                <span className="text-slate-300 w-28 shrink-0 tabular-nums">
                  {new Date(e.timestamp).toLocaleString('zh-CN', {
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${label.color}`}>{label.text}</span>
                <span className="text-slate-600 font-medium truncate">{e.capabilityId}</span>
                <span className="text-slate-300 truncate">{e.userId}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
