'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useToastStore } from '@/stores/toastStore';
import { apiFetch } from '@/utils/api-client';
import { HubIcon } from '../hub-icons';
import {
  SettingsResourceIconButton,
  SettingsResourceToggleSwitch,
  settingsResourceActionGroupClass,
  settingsResourceCardClass,
} from '../SettingsResourceCard';
import { InstallPreviewModal } from './InstallPreviewModal';

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
    models?: {
      name: string;
      size: string;
      autoDownload: boolean;
      isDefault?: boolean;
      description?: string;
    }[];
    estimatedMinutes?: number;
  };
  scripts?: {
    install?: string;
    start?: string;
    stop?: string;
    uninstall?: string;
  };
  configVars?: string[];
}

type ServiceStatus = 'running' | 'starting' | 'installing' | 'stopped' | 'unknown' | 'error';

interface ServiceState {
  manifest: ServiceManifest;
  status: ServiceStatus;
  installed: boolean;
  enabled: boolean;
  selectedModel?: string;
  lastChecked: number | null;
  healthDetail?: Record<string, unknown>;
  error?: string;
}

const STATUS_CONFIG: Record<ServiceStatus, { dot: string; label: string }> = {
  running: { dot: 'bg-conn-emerald-text', label: '运行中' },
  starting: { dot: 'bg-conn-amber-text', label: '启动中' },
  installing: { dot: 'bg-conn-amber-text', label: '安装中' },
  stopped: { dot: 'bg-cafe-surface-sunken', label: '未启动' },
  error: { dot: 'bg-conn-red-text', label: '异常' },
  unknown: { dot: 'bg-cafe-surface-sunken', label: '未知' },
};

const ROW_CLASS = 'flex items-center gap-4 px-5 py-4';

interface ServiceStatusPanelProps {
  filterFeatures?: string[];
  title?: string;
}

export function ServiceStatusPanel({ filterFeatures, title }: ServiceStatusPanelProps) {
  const addToast = useToastStore((s) => s.addToast);
  const [services, setServices] = useState<ServiceState[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<Map<string, string>>(new Map());
  const pollRef = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());
  const [installPreview, setInstallPreview] = useState<ServiceManifest | null>(null);

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

  useEffect(() => {
    const ref = pollRef.current;
    return () => {
      for (const iv of ref.values()) clearInterval(iv);
      ref.clear();
    };
  }, []);

  const startLogPoll = useCallback((id: string) => {
    if (pollRef.current.has(id)) return;
    const iv = setInterval(async () => {
      try {
        const r = await apiFetch(`/api/services/${id}/logs`);
        if (r.ok) {
          const data = (await r.json()) as { lines: string[] };
          const last = data.lines.filter((l) => l.trim()).pop();
          if (last) setProgress((prev) => new Map(prev).set(id, last));
        }
      } catch {
        /* ignore */
      }
    }, 2000);
    pollRef.current.set(id, iv);
  }, []);

  const stopLogPoll = useCallback((id: string) => {
    const iv = pollRef.current.get(id);
    if (iv) {
      clearInterval(iv);
      pollRef.current.delete(id);
    }
    setProgress((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const handleAction = useCallback(
    async (id: string, action: 'start' | 'stop' | 'install' | 'uninstall', opts?: { model?: string }) => {
      const key = `${id}:${action}`;
      setActing((prev) => new Set(prev).add(key));
      const longRunning = action === 'install' || action === 'uninstall';
      if (longRunning) startLogPoll(id);
      try {
        const fetchOpts: RequestInit = { method: 'POST' };
        if (opts?.model) {
          fetchOpts.headers = { 'Content-Type': 'application/json' };
          fetchOpts.body = JSON.stringify({ model: opts.model });
        }
        const res = await apiFetch(`/api/services/${id}/${action}`, fetchOpts);
        await fetchServices();
        if (res.ok && action === 'start') {
          startLogPoll(id);
          const maxWait = 120_000;
          const deadline = Date.now() + maxWait;
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 2000));
            await fetchServices();
            const healthRes = await apiFetch(`/api/services/${id}/health`);
            if (healthRes.ok) {
              const state = (await healthRes.json()) as { status: string };
              if (state.status === 'running') break;
              if (state.status === 'error') break;
            }
          }
          stopLogPoll(id);
        }
        if (res.ok && action === 'stop') {
          const deadline = Date.now() + 10_000;
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 1000));
            const healthRes = await apiFetch(`/api/services/${id}/health`);
            if (healthRes.ok) {
              const state = (await healthRes.json()) as { status: string };
              if (state.status !== 'running') break;
            } else {
              break;
            }
          }
        }
        await fetchServices();
      } catch {
        stopLogPoll(id);
      } finally {
        if (longRunning) stopLogPoll(id);
        setActing((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    },
    [fetchServices, startLogPoll, stopLogPoll],
  );

  const handleToggle = useCallback(
    async (s: ServiceState) => {
      const m = s.manifest;
      const nextEnabled = !s.enabled;

      if (nextEnabled && !s.installed) {
        setInstallPreview(m);
        return;
      }

      const key = `${m.id}:toggle`;
      setActing((prev) => new Set(prev).add(key));
      try {
        const res = await apiFetch(`/api/services/${m.id}/toggle`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: nextEnabled }),
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
          addToast({
            type: 'error',
            title: `${m.name} ${nextEnabled ? '启用' : '禁用'}失败`,
            message: (body as { error?: string }).error ?? `HTTP ${res.status}`,
            duration: 5000,
          });
          return;
        }

        if (nextEnabled && s.status !== 'running' && s.status !== 'starting') {
          await handleAction(m.id, 'start');
        } else if (!nextEnabled && s.status === 'running') {
          await handleAction(m.id, 'stop');
        } else {
          await fetchServices();
        }
      } catch {
        addToast({ type: 'error', title: '网络错误', message: `无法连接到服务管理 API`, duration: 5000 });
      } finally {
        setActing((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    },
    [fetchServices, handleAction, addToast],
  );

  if (loading) return null;
  if (services.length === 0) return null;

  return (
    <div className="space-y-3">
      {title && <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cafe-muted">{title}</p>}
      {services.map((s) => {
        const m = s.manifest;
        const isTransitional = s.status === 'starting' || s.status === 'installing';
        const busy = [...acting].some((a) => a.startsWith(`${m.id}:`));
        const cfg = STATUS_CONFIG[s.status] ?? STATUS_CONFIG.unknown;
        const statusLabel = !s.installed ? '未安装' : cfg.label;
        const statusDot = !s.installed ? 'bg-cafe-surface-sunken' : cfg.dot;
        const toggleDisabled = busy || isTransitional;

        return (
          <div key={m.id} className={settingsResourceCardClass}>
            <div className={ROW_CLASS}>
              <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${statusDot}`} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-cafe">{m.name}</p>
                <p className="mt-0.5 truncate text-xs text-cafe-muted">
                  {m.type}
                  {m.port ? ` · :${m.port}` : ''} · {statusLabel}
                </p>
                {progress.get(m.id) && (
                  <p className="mt-1 truncate text-[11px] text-cafe-secondary font-mono">{progress.get(m.id)}</p>
                )}
                {s.error && <p className="mt-0.5 truncate text-[11px] text-conn-red-text">{s.error}</p>}
              </div>
              <div className={settingsResourceActionGroupClass}>
                {!s.installed && !isTransitional ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setInstallPreview(m)}
                    className="console-button-secondary px-3 py-1.5 text-xs disabled:opacity-40"
                  >
                    {acting.has(`${m.id}:install`) ? '安装中...' : '安装'}
                  </button>
                ) : s.installed ? (
                  <>
                    <SettingsResourceToggleSwitch
                      enabled={s.enabled}
                      busy={toggleDisabled}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleToggle(s);
                      }}
                    />
                    {!s.enabled && !isTransitional && !!m.scripts?.uninstall && (
                      <SettingsResourceIconButton
                        disabled={busy}
                        onClick={() => handleAction(m.id, 'uninstall')}
                        title="卸载"
                        aria-label="卸载"
                        tone="danger"
                      >
                        <HubIcon name="trash" className="h-4 w-4" />
                      </SettingsResourceIconButton>
                    )}
                  </>
                ) : null}
              </div>
            </div>
          </div>
        );
      })}
      {installPreview?.prerequisites && (
        <InstallPreviewModal
          open={!!installPreview}
          serviceName={installPreview.name}
          prerequisites={installPreview.prerequisites}
          onConfirm={async (selectedModel) => {
            const id = installPreview.id;
            setInstallPreview(null);
            await apiFetch(`/api/services/${id}/toggle`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ enabled: true, model: selectedModel }),
            });
            await handleAction(id, 'install', { model: selectedModel });
          }}
          onCancel={() => setInstallPreview(null)}
        />
      )}
    </div>
  );
}
