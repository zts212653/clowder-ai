'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { HubIcon } from '../hub-icons';
import {
  settingsResourceAvatarClass,
  settingsResourceCardClass,
  settingsResourceRowClass,
  settingsResourceActionGroupClass,
  SettingsResourceToggleSwitch,
  SettingsResourceIconButton,
} from '../SettingsResourceCard';

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
  };
  configVars?: string[];
}

type ServiceStatus = 'running' | 'stopped' | 'unknown' | 'error';

interface ServiceState {
  manifest: ServiceManifest;
  status: ServiceStatus;
  lastChecked: number | null;
  healthDetail?: Record<string, unknown>;
  error?: string;
}

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
    async (id: string, action: 'start' | 'stop' | 'install') => {
      setActing(`${id}:${action}`);
      try {
        const res = await apiFetch(`/api/services/${id}/${action}`, { method: 'POST' });
        if (res.ok) {
          await new Promise((r) => setTimeout(r, 1500));
          await fetchServices();
        }
      } catch {
        /* ignore */
      } finally {
        setActing(null);
      }
    },
    [fetchServices],
  );

  const handleToggle = useCallback(
    (s: ServiceState) => {
      if (s.status === 'running') {
        handleAction(s.manifest.id, 'stop');
      } else if (s.manifest.scripts?.start) {
        handleAction(s.manifest.id, 'start');
      }
    },
    [handleAction],
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
        const canToggle = !!m.scripts?.start || isRunning;
        const busy = acting?.startsWith(`${m.id}:`) ?? false;
        const subInfo = `${m.type}${m.port ? ` · :${m.port}` : ''}`;

        return (
          <div key={m.id} className={settingsResourceCardClass}>
            <div className={settingsResourceRowClass}>
              <div className="flex min-w-0 flex-1 items-center gap-4">
                <div className={settingsResourceAvatarClass}>
                  <HubIcon name={isRunning ? 'activity' : 'box'} className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[15px] font-extrabold text-cafe">{m.name}</p>
                  <p className="mt-0.5 truncate text-xs text-cafe-secondary">{subInfo}</p>
                </div>
              </div>
              <div className={settingsResourceActionGroupClass}>
                {!canToggle && m.scripts?.install && (
                  <>
                    <span className="text-[11px] text-conn-amber-text">需要安装</span>
                    <SettingsResourceIconButton
                      disabled={busy}
                      onClick={() => handleAction(m.id, 'install')}
                      title="安装服务"
                      aria-label="安装服务"
                    >
                      {busy && acting === `${m.id}:install` ? (
                        <span className="text-[11px]">...</span>
                      ) : (
                        <HubIcon name="settings" className="h-4 w-4" />
                      )}
                    </SettingsResourceIconButton>
                  </>
                )}
                {canToggle && (
                  <SettingsResourceToggleSwitch
                    enabled={isRunning}
                    busy={busy}
                    onClick={() => handleToggle(s)}
                    title={isRunning ? '停止服务' : '启动服务'}
                  />
                )}
                {s.error && (
                  <span className="text-[11px] text-conn-red-text" title={s.error}>
                    {s.error.length > 20 ? `${s.error.slice(0, 20)}…` : s.error}
                  </span>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
