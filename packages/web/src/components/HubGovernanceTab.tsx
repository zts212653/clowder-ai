'use client';

import type { GovernanceHealthSummary } from '@cat-cafe/shared';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { GovernanceInstaller } from './GovernanceInstaller';

interface GovernanceHealthResponse {
  projects: GovernanceHealthSummary[];
}

const STATUS_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  healthy: { bg: 'bg-conn-green-bg', text: 'text-conn-green-text', label: '已安装' },
  stale: { bg: 'bg-conn-amber-bg', text: 'text-conn-amber-text', label: '旧版本' },
  missing: { bg: 'bg-conn-red-bg', text: 'text-conn-red-text', label: '安装有缺项' },
  'never-synced': { bg: 'bg-cafe-surface-elevated', text: 'text-cafe-secondary', label: '未安装' },
};

function unsyncedSummary(projectPath: string): GovernanceHealthSummary {
  return { projectPath, status: 'never-synced', packVersion: null, lastSyncedAt: null, findings: [] };
}

async function discoverUnsynced(known: readonly GovernanceHealthSummary[]): Promise<GovernanceHealthSummary[]> {
  try {
    const threadsRes = await apiFetch('/api/threads');
    if (!threadsRes.ok) return [...known];
    const { threads } = (await threadsRes.json()) as { threads: { projectPath?: string }[] };
    const projectPaths = [
      ...new Set(
        threads.flatMap((thread) =>
          thread.projectPath && thread.projectPath !== 'default' ? [thread.projectPath] : [],
        ),
      ),
    ];
    if (projectPaths.length === 0) return [...known];
    const discoverRes = await apiFetch('/api/governance/discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPaths }),
    });
    if (!discoverRes.ok) return [...known];
    const { unsynced } = (await discoverRes.json()) as { unsynced: string[] };
    const knownPaths = new Set(known.map((project) => project.projectPath));
    return [...known, ...unsynced.filter((path) => !knownPaths.has(path)).map(unsyncedSummary)];
  } catch {
    return [...known];
  }
}

export function HubGovernanceTab() {
  const [projects, setProjects] = useState<GovernanceHealthSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedProject, setExpandedProject] = useState<string | null>(null);

  const fetchHealth = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/governance/health');
      if (!res.ok) {
        setError('加载治理状态失败');
        return;
      }
      const data = (await res.json()) as GovernanceHealthResponse;
      setProjects(await discoverUnsynced(data.projects));
    } catch {
      setError('网络错误');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHealth();
  }, [fetchHealth]);

  if (loading) {
    return <p className="text-sm text-cafe-muted">加载治理状态中...</p>;
  }

  if (error) {
    return <p className="text-sm text-conn-red-text bg-conn-red-bg rounded-lg px-3 py-2">{error}</p>;
  }

  if (projects.length === 0) {
    return (
      <div className="text-center py-8 text-cafe-muted">
        <p className="text-sm">暂无外部项目治理记录</p>
        <p className="text-xs mt-1">派遣不会自动写入项目；有需要时可在这里主动安装。</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-cafe-secondary">外部项目治理安装</h3>
          <p className="mt-1 text-xs text-cafe-muted">派遣不会自动写入项目；配置、预览与撤销都由你显式发起。</p>
        </div>
        <button
          type="button"
          onClick={fetchHealth}
          className="rounded-lg bg-cafe-accent px-3 py-1.5 text-xs font-semibold text-[var(--cafe-surface)] transition-colors hover:bg-cafe-accent-hover"
        >
          刷新
        </button>
      </div>

      <div className="border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-cafe-surface-elevated text-left">
            <tr>
              <th className="px-3 py-2 font-medium text-cafe-secondary">项目路径</th>
              <th className="px-3 py-2 font-medium text-cafe-secondary">状态</th>
              <th className="px-3 py-2 font-medium text-cafe-secondary">版本</th>
              <th className="px-3 py-2 font-medium text-cafe-secondary">上次同步</th>
              <th className="px-3 py-2 font-medium text-cafe-secondary">操作</th>
            </tr>
          </thead>
          {projects.map((p) => {
            const fallback = STATUS_STYLES['never-synced'];
            const style = STATUS_STYLES[p.status] ?? fallback;
            // display-only: always use forward slash regardless of OS
            const shortPath = p.projectPath.split(/[/\\]/).slice(-2).join('/');
            const syncDate = p.lastSyncedAt ? new Date(p.lastSyncedAt).toLocaleDateString('zh-CN') : '—';

            const expanded = expandedProject === p.projectPath;
            return (
              <tbody key={p.projectPath} className="divide-y divide-cafe-border">
                <tr className="hover:bg-cafe-surface-elevated">
                  <td className="px-3 py-2 font-mono text-xs" title={p.projectPath}>
                    {shortPath}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${style.bg} ${style.text}`}>
                      {style.label}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs text-cafe-secondary">{p.packVersion ?? '—'}</td>
                  <td className="px-3 py-2 text-xs text-cafe-secondary">{syncDate}</td>
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      onClick={() => setExpandedProject(expanded ? null : p.projectPath)}
                      className="text-xs px-2 py-1 rounded-lg bg-cafe-accent text-[var(--cafe-surface)] hover:bg-cafe-accent-hover transition-colors"
                    >
                      {expanded ? '收起' : '配置'}
                    </button>
                  </td>
                </tr>
                {expanded && (
                  <tr>
                    <td colSpan={5} className="bg-cafe-surface-canvas p-3">
                      <GovernanceInstaller
                        projectPath={p.projectPath}
                        allowCleanup={p.status !== 'never-synced'}
                        onChanged={fetchHealth}
                      />
                    </td>
                  </tr>
                )}
              </tbody>
            );
          })}
        </table>
      </div>
    </div>
  );
}
