'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { HubIcon } from '../hub-icons';
import {
  SettingsResourceIconButton,
  SettingsResourceToggleSwitch,
  settingsResourceCardClass,
} from '../SettingsResourceCard';
import { InstallPreviewModal } from './InstallPreviewModal';
import { SettingsText } from './primitives';
import {
  adaptServiceState,
  type HomeServiceState,
  type ServiceUiState,
  type ServiceUiStatus,
} from './service-ui-adapter';

const STATUS_DOT_COLOR: Record<string, string> = {
  running: 'var(--conn-emerald-text)',
  stopped: 'var(--cafe-surface-sunken)',
  not_configured: 'var(--cafe-surface-sunken)',
  error: 'var(--conn-red-text)',
  installing: 'var(--conn-amber-text)',
  starting: 'var(--conn-amber-text)',
  stopping: 'var(--conn-amber-text)',
  uninstalling: 'var(--conn-amber-text)',
};

const ROW_STYLE = { paddingInline: '1.25rem', paddingBlock: '0.75rem' } as const;
const LOG_POLL_MS = 2000;
const LIFECYCLE_BUSY_STATUSES = new Set<ServiceUiStatus>(['installing', 'starting', 'stopping', 'uninstalling']);
const SERVICE_INSTALL_BUTTON_CLASS =
  'rounded-lg bg-cafe-accent px-3 py-1.5 text-xs font-semibold text-[var(--cafe-surface)] transition-colors hover:bg-cafe-accent-hover disabled:opacity-50';

interface ServiceStatusPanelProps {
  filterFeatures?: readonly string[];
  title?: string;
  anchorId?: string;
  onStateChange?: () => void;
}

function serviceMatchesFilter(service: HomeServiceState, filterFeatures?: readonly string[]): boolean {
  if (!filterFeatures?.length) return true;
  return service.features.some((f) => filterFeatures.includes(f));
}

export function ServiceStatusPanel({ filterFeatures, title, anchorId, onStateChange }: ServiceStatusPanelProps) {
  const [services, setServices] = useState<ServiceUiState[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<{ id: string; message: string } | null>(null);
  const [installTarget, setInstallTarget] = useState<ServiceUiState | null>(null);
  const [reconfigureTarget, setReconfigureTarget] = useState<ServiceUiState | null>(null);
  const [progress, setProgress] = useState<Map<string, string>>(new Map());
  const pollRef = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());

  const fetchServices = useCallback(async () => {
    try {
      const res = await apiFetch('/api/services');
      if (!res.ok) {
        setServices([]);
        return;
      }
      const payload = (await res.json()) as { services?: unknown };
      const list = Array.isArray(payload.services) ? (payload.services as HomeServiceState[]) : [];
      setServices(list.filter((s) => serviceMatchesFilter(s, filterFeatures)).map(adaptServiceState));
      onStateChange?.();
    } catch {
      setServices([]);
    } finally {
      setLoading(false);
    }
  }, [filterFeatures, onStateChange]);

  useEffect(() => {
    void fetchServices();
  }, [fetchServices]);

  useEffect(() => {
    const polls = pollRef.current;
    return () => {
      for (const interval of polls.values()) clearInterval(interval);
      polls.clear();
    };
  }, []);

  const pollServiceLog = useCallback(async (serviceId: string) => {
    try {
      const res = await apiFetch(`/api/services/${serviceId}/logs`);
      if (!res.ok) return;
      const data = (await res.json()) as { lines?: string[] };
      const lastLine = data.lines?.filter(Boolean).pop();
      if (lastLine) setProgress((prev) => new Map(prev).set(serviceId, lastLine));
    } catch {
      /* ignore polling errors */
    }
  }, []);

  const stopLogPoll = useCallback((serviceId: string) => {
    const existing = pollRef.current.get(serviceId);
    if (existing) {
      clearInterval(existing);
      pollRef.current.delete(serviceId);
    }
  }, []);

  const startLogPoll = useCallback(
    (serviceId: string) => {
      stopLogPoll(serviceId);
      void pollServiceLog(serviceId);
      const interval = setInterval(() => {
        void pollServiceLog(serviceId);
      }, LOG_POLL_MS);
      pollRef.current.set(serviceId, interval);
    },
    [pollServiceLog, stopLogPoll],
  );

  useEffect(() => {
    const busyIds = new Set(services.filter((service) => LIFECYCLE_BUSY_STATUSES.has(service.status)).map((s) => s.id));
    for (const serviceId of busyIds) startLogPoll(serviceId);
    for (const serviceId of pollRef.current.keys()) {
      if (!busyIds.has(serviceId) && !acting.has(serviceId)) stopLogPoll(serviceId);
    }
  }, [acting, services, startLogPoll, stopLogPoll]);

  useEffect(() => {
    const hasBusyService = acting.size > 0 || services.some((service) => LIFECYCLE_BUSY_STATUSES.has(service.status));
    if (!hasBusyService) return;
    const interval = setInterval(() => {
      void fetchServices();
    }, LOG_POLL_MS);
    return () => clearInterval(interval);
  }, [acting, fetchServices, services]);

  async function executeAction(serviceId: string, action: string, model?: string, port?: number) {
    setActing((prev) => new Set(prev).add(serviceId));
    setActionError(null);
    if (action === 'install' || action === 'start' || action === 'stop' || action === 'uninstall') {
      startLogPoll(serviceId);
    }
    try {
      // Serialize model + port for install (codex P2 3266352848 — install
      // modal accepts a port input but executeAction was previously dropping
      // it on the floor, so user-entered ports silently collided with the
      // default/env-derived port).
      // reconfigure shares the same body shape (model? + port?) so the
      // backend can do port-only vs. model-change branching server-side.
      const installBody: { model?: string; port?: number } = {};
      if (model) installBody.model = model;
      if (typeof port === 'number') installBody.port = port;
      const sendsBody = (action === 'install' || action === 'reconfigure') && (model || typeof port === 'number');
      const body = sendsBody ? JSON.stringify(installBody) : '{}';
      const res = await apiFetch(`/api/services/${serviceId}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      const data = (await res.json()) as { ok?: boolean; error?: string; output?: string };
      if (!data.ok) {
        const output = typeof data.output === 'string' ? data.output.trim() : '';
        const message = data.error ?? `${action} failed`;
        setActionError({ id: serviceId, message: output ? `${message}\n${output}` : message });
      }
      await fetchServices();
    } catch {
      setActionError({ id: serviceId, message: `${action} request failed` });
    } finally {
      stopLogPoll(serviceId);
      setProgress((prev) => {
        const next = new Map(prev);
        next.delete(serviceId);
        return next;
      });
      setActing((prev) => {
        const next = new Set(prev);
        next.delete(serviceId);
        return next;
      });
    }
  }

  function handleToggle(service: ServiceUiState) {
    void executeAction(service.id, service.enabled ? 'stop' : 'start');
  }

  function handleAction(service: ServiceUiState, action: string) {
    if (action === 'install' && service.prerequisites) {
      setInstallTarget(service);
      return;
    }
    void executeAction(service.id, action);
  }

  if (loading) return null;
  if (services.length === 0) return null;

  return (
    <div id={anchorId} className="space-y-3 transition-shadow">
      {title && (
        <SettingsText as="p" tone="muted" className="font-semibold uppercase tracking-[0.22em]">
          {title}
        </SettingsText>
      )}
      {services.map((service) => {
        const dotColor = STATUS_DOT_COLOR[service.status] ?? STATUS_DOT_COLOR.not_configured;
        const isBusy = acting.has(service.id) || LIFECYCLE_BUSY_STATUSES.has(service.status);
        const error = actionError?.id === service.id ? actionError.message : null;
        const logLine = progress.get(service.id);

        return (
          <div key={service.id} className={settingsResourceCardClass}>
            <div className="flex items-center gap-4" style={ROW_STYLE}>
              <span
                className="inline-block h-2 w-2 shrink-0"
                style={{ borderRadius: '9999px', backgroundColor: dotColor }}
              />
              <div className="min-w-0 flex-1">
                <SettingsText as="p" variant="sm" tone="default" className="font-medium">
                  {service.name}
                </SettingsText>
                <SettingsText as="p" tone="muted" className="mt-0.5 truncate">
                  {service.category} · {service.statusLabel}
                  {service.selectedModel ? ` · ${service.selectedModel}` : ''}
                  {service.endpoint ? ` · ${service.endpoint}` : ''}
                </SettingsText>
                {service.error && (
                  <SettingsText as="p" tone="red" className="mt-0.5 truncate">
                    {service.error}
                  </SettingsText>
                )}
                {error && (
                  <SettingsText as="p" tone="red" className="mt-0.5 whitespace-pre-wrap break-words">
                    {error}
                  </SettingsText>
                )}
                {logLine && (
                  <SettingsText as="p" tone="muted" className="mt-0.5 truncate font-mono">
                    {logLine}
                  </SettingsText>
                )}
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {!service.installed && service.installable && (
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => handleAction(service, 'install')}
                    className={SERVICE_INSTALL_BUTTON_CLASS}
                  >
                    {service.status === 'installing' ? '安装中' : isBusy ? '...' : '安装'}
                  </button>
                )}
                {service.installed && service.installable && (
                  <>
                    <SettingsResourceToggleSwitch
                      enabled={service.enabled}
                      busy={isBusy}
                      onClick={() => handleToggle(service)}
                      title={service.enabled ? '停止服务' : '启动服务'}
                    />
                    {!service.enabled && (
                      <>
                        <SettingsResourceIconButton
                          disabled={isBusy}
                          onClick={() => setReconfigureTarget(service)}
                          title="修改端口或模型"
                        >
                          <HubIcon name="settings" className="h-3.5 w-3.5" />
                        </SettingsResourceIconButton>
                        <SettingsResourceIconButton
                          tone="danger"
                          disabled={isBusy}
                          onClick={() => void executeAction(service.id, 'uninstall')}
                          title="卸载"
                        >
                          <HubIcon name="trash" className="h-3.5 w-3.5" />
                        </SettingsResourceIconButton>
                      </>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        );
      })}

      {installTarget && (
        <InstallPreviewModal
          open={true}
          serviceId={installTarget.id}
          serviceName={installTarget.name}
          estimatedMinutes={installTarget.prerequisites?.estimatedMinutes}
          onConfirm={({ model, port }) => {
            const id = installTarget.id;
            setInstallTarget(null);
            void executeAction(id, 'install', model, port);
          }}
          onCancel={() => setInstallTarget(null)}
        />
      )}

      {reconfigureTarget && (
        <InstallPreviewModal
          open={true}
          mode="reconfigure"
          serviceId={reconfigureTarget.id}
          serviceName={reconfigureTarget.name}
          initialModel={reconfigureTarget.selectedModel}
          initialPort={reconfigureTarget.port}
          onConfirm={({ model, port }) => {
            const id = reconfigureTarget.id;
            setReconfigureTarget(null);
            void executeAction(id, 'reconfigure', model, port);
          }}
          onCancel={() => setReconfigureTarget(null)}
        />
      )}
    </div>
  );
}
