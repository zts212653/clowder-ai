'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

interface ServiceManifest {
  id: string;
  name: string;
  type: 'python' | 'node' | 'binary';
  port?: number;
  enablesFeatures: string[];
  prerequisites?: {
    runtime?: string;
    venvPath?: string;
    packages?: string[];
  };
  scripts?: {
    install?: string;
    start?: string;
    stop?: string;
    uninstall?: string;
  };
  configVars?: string[];
}

type ServiceStatus = 'running' | 'stopped' | 'unknown' | 'error';

interface ServiceState {
  manifest: ServiceManifest;
  status: ServiceStatus;
  installed: boolean;
  lastChecked: number | null;
  healthDetail?: Record<string, unknown>;
  error?: string;
}

const STATUS_CONFIG: Record<ServiceStatus, { dot: string; label: string }> = {
  running: { dot: 'bg-conn-emerald-text', label: '运行中' },
  stopped: { dot: 'bg-cafe-surface-sunken', label: '未启动' },
  error: { dot: 'bg-conn-red-text', label: '异常' },
  unknown: { dot: 'bg-cafe-surface-sunken', label: '未知' },
};

const CARD_CLASS = 'rounded-xl bg-[var(--console-card-bg)] shadow-[0_8px_22px_rgba(43,33,26,0.04)]';

interface ServiceStatusPanelProps {
  filterFeatures?: string[];
  title?: string;
}

export function ServiceStatusPanel({ filterFeatures, title }: ServiceStatusPanelProps) {
  const [services, setServices] = useState<ServiceState[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);

  const fetchServices = useCallback(async () => {
    try {
      const res = await apiFetch('/api/services');
      if (res.ok) {
        const data = (await res.json()) as { services: ServiceState[] };
        let list = data.services;
        if (filterFeatures?.length) {
          list = list.filter((s) => s.manifest.enablesFeatures.some((f) => filterFeatures.includes(f)));
        }
        setServices(list);
      }
    } catch {
      /* network error */
    } finally {
      setLoading(false);
    }
  }, [filterFeatures]);

  useEffect(() => {
    fetchServices();
  }, [fetchServices]);

  const handleAction = useCallback(
    async (id: string, action: 'start' | 'stop' | 'install' | 'uninstall') => {
      setActing(`${id}:${action}`);
      try {
        const res = await apiFetch(`/api/services/${id}/${action}`, { method: 'POST' });
        if (res.ok) {
          await new Promise((r) => setTimeout(r, 1500));
        }
        await fetchServices();
      } catch {
        /* ignore */
      } finally {
        setActing(null);
      }
    },
    [fetchServices],
  );

  if (loading) return null;
  if (services.length === 0) return null;

  return (
    <div className="space-y-3">
      {title && (
        <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cafe-muted">{title}</p>
      )}
      {services.map((s) => {
        const m = s.manifest;
        const isRunning = s.status === 'running';
        const installed = s.installed;
        const hasInstall = !!m.scripts?.install;
        const hasUninstall = !!m.scripts?.uninstall;
        const hasStart = !!m.scripts?.start;
        const busy = acting?.startsWith(`${m.id}:`) ?? false;
        const statusLabel = !installed ? '未安装' : STATUS_CONFIG[s.status].label;
        const statusDot = !installed ? 'bg-conn-amber-text' : STATUS_CONFIG[s.status].dot;

        return (
          <div key={m.id} className={`${CARD_CLASS} flex items-center gap-4 px-5 py-4`}>
            <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${statusDot}`} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-cafe">{m.name}</p>
              <p className="mt-0.5 truncate text-xs text-cafe-muted">
                {m.type}{m.port ? ` · :${m.port}` : ''} · {statusLabel}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {s.error && (
                <span className="text-[11px] text-conn-red-text" title={s.error}>
                  {s.error.length > 20 ? `${s.error.slice(0, 20)}…` : s.error}
                </span>
              )}
              {!installed && hasInstall && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => handleAction(m.id, 'install')}
                  className="console-button-secondary px-3 py-1 text-xs disabled:opacity-40"
                >
                  {busy && acting === `${m.id}:install` ? '安装中...' : '安装'}
                </button>
              )}
              {installed && !isRunning && hasStart && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => handleAction(m.id, 'start')}
                  className="console-button-secondary px-3 py-1 text-xs disabled:opacity-40"
                >
                  {busy && acting === `${m.id}:start` ? '启动中...' : '启动'}
                </button>
              )}
              {isRunning && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => handleAction(m.id, 'stop')}
                  className="console-button-secondary px-3 py-1 text-xs disabled:opacity-40"
                >
                  {busy && acting === `${m.id}:stop` ? '停止中...' : '停止'}
                </button>
              )}
              {installed && !isRunning && hasUninstall && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => handleAction(m.id, 'uninstall')}
                  className="console-button-ghost px-3 py-1 text-xs text-cafe-muted disabled:opacity-40"
                >
                  {busy && acting === `${m.id}:uninstall` ? '卸载中...' : '卸载'}
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
