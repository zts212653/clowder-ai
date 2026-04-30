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

const STATUS_CONFIG: Record<ServiceStatus, { dot: string; label: string }> = {
  running: { dot: 'bg-conn-emerald-text', label: '运行中' },
  stopped: { dot: 'bg-cafe-surface-sunken', label: '未启动' },
  error: { dot: 'bg-conn-red-text', label: '异常' },
  unknown: { dot: 'bg-cafe-surface-sunken', label: '未知' },
};

const STATUS_TONE: Record<ServiceStatus, 'active' | 'available' | 'error' | 'info'> = {
  running: 'active',
  stopped: 'available',
  error: 'error',
  unknown: 'info',
};

interface ServiceStatusPanelProps {
  filterFeatures?: string[];
  title?: string;
  expandable?: boolean;
}

export function ServiceStatusPanel({ filterFeatures, title, expandable }: ServiceStatusPanelProps) {
  const [services, setServices] = useState<ServiceState[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

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
      /* network error — leave empty */
    } finally {
      setLoading(false);
    }
  }, [filterFeatures]);

  useEffect(() => {
    fetchServices();
  }, [fetchServices]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchServices();
    setRefreshing(false);
  }, [fetchServices]);

  const handleHealthCheck = useCallback(async (id: string) => {
    try {
      const res = await apiFetch(`/api/services/${id}/health`);
      if (res.ok) {
        const updated = (await res.json()) as ServiceState;
        setServices((prev) => prev.map((s) => (s.manifest.id === id ? updated : s)));
      }
    } catch {
      /* ignore */
    }
  }, []);

  if (loading) return null;
  if (services.length === 0) return null;

  const showDetail = expandable ?? !filterFeatures;

  return (
    <div className="console-card rounded-xl p-4 md:p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="space-y-1">
          {title && <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cafe-muted">{title}</p>}
          <p className="text-sm text-cafe-secondary">把相关服务的运行状态、依赖和启动信息集中到一张系统卡片里。</p>
        </div>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={refreshing}
          className="console-button-secondary shrink-0 disabled:opacity-40"
        >
          {refreshing ? '刷新中...' : '刷新'}
        </button>
      </div>
      <div className="space-y-2">
        {services.map((s) => {
          const cfg = STATUS_CONFIG[s.status];
          const isExpanded = expanded === s.manifest.id;
          return (
            <div
              key={s.manifest.id}
              className="console-list-card rounded-xl px-4 py-4"
              data-active={isExpanded ? 'true' : 'false'}
            >
              <div className="flex items-center justify-between gap-3 text-xs">
                <button
                  type="button"
                  onClick={() => showDetail && setExpanded(isExpanded ? null : s.manifest.id)}
                  className={`min-w-0 text-left text-cafe ${showDetail ? 'cursor-pointer' : ''}`}
                >
                  <div className="flex items-center gap-3">
                    {showDetail && (
                      <span className="console-pill flex h-8 w-8 items-center justify-center rounded-full text-cafe-secondary">
                        <svg
                          className={`h-3.5 w-3.5 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                          viewBox="0 0 20 20"
                          fill="currentColor"
                        >
                          <path
                            fillRule="evenodd"
                            d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
                            clipRule="evenodd"
                          />
                        </svg>
                      </span>
                    )}
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-cafe">{s.manifest.name}</p>
                      <p className="mt-1 text-xs text-cafe-muted">
                        {s.manifest.type}
                        {s.manifest.port ? ` · :${s.manifest.port}` : ''}
                        {s.manifest.enablesFeatures.length > 0
                          ? ` · ${s.manifest.enablesFeatures.length} features`
                          : ''}
                      </p>
                    </div>
                  </div>
                </button>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <span className="console-status-chip" data-status={STATUS_TONE[s.status]}>
                    <span className={`inline-block h-1.5 w-1.5 rounded-full ${cfg.dot}`} />
                    {cfg.label}
                  </span>
                  {s.error && (
                    <span className="console-status-chip" data-status="error">
                      {s.error}
                    </span>
                  )}
                </div>
              </div>
              {showDetail && isExpanded && (
                <ServiceDetail service={s} onHealthCheck={() => handleHealthCheck(s.manifest.id)} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ServiceDetail({ service, onHealthCheck }: { service: ServiceState; onHealthCheck: () => void }) {
  const m = service.manifest;
  return (
    <div className="console-card-soft mt-4 space-y-3 rounded-xl px-4 py-4 text-xs text-cafe-muted">
      <div className="console-data-grid">
        <DetailTile label="类型" value={m.type} />
        {m.port ? <DetailTile label="端口" value={String(m.port)} /> : null}
        {m.prerequisites?.runtime ? <DetailTile label="运行环境" value={m.prerequisites.runtime} /> : null}
      </div>

      {m.enablesFeatures.length > 0 && (
        <div>
          <p className="console-data-tile-label">功能</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {m.enablesFeatures.map((feature) => (
              <span
                key={feature}
                className="console-pill inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold text-cafe-secondary"
              >
                {feature}
              </span>
            ))}
          </div>
        </div>
      )}

      {m.prerequisites?.packages && m.prerequisites.packages.length > 0 && (
        <div>
          <p className="console-data-tile-label">依赖</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {m.prerequisites.packages.map((pkg) => (
              <span
                key={pkg}
                className="console-pill inline-flex items-center rounded-full px-2.5 py-1 font-mono text-[11px] text-cafe-secondary"
              >
                {pkg}
              </span>
            ))}
          </div>
        </div>
      )}

      {m.scripts?.start && <DetailBlock label="启动命令" value={m.scripts.start} mono />}

      {m.configVars && m.configVars.length > 0 && (
        <div>
          <p className="console-data-tile-label">配置变量</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {m.configVars.map((name) => (
              <span
                key={name}
                className="console-pill inline-flex items-center rounded-full px-2.5 py-1 font-mono text-[11px] text-cafe-secondary"
              >
                {name}
              </span>
            ))}
          </div>
        </div>
      )}

      <button type="button" onClick={onHealthCheck} className="console-button-secondary">
        检查健康
      </button>
    </div>
  );
}

function DetailTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="console-data-tile">
      <p className="console-data-tile-label">{label}</p>
      <p className="console-data-tile-value">{value}</p>
    </div>
  );
}

function DetailBlock({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="console-data-tile">
      <p className="console-data-tile-label">{label}</p>
      <p className={`console-data-tile-value ${mono ? 'font-mono text-[12px]' : ''}`}>{value}</p>
    </div>
  );
}
