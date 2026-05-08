'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { HubIcon } from '../hub-icons';
import {
  settingsResourceActionGroupClass,
  settingsResourceAvatarClass,
  settingsResourceCardClass,
  settingsResourceRowClass,
} from '../SettingsResourceCard';
import { GithubConfigPanel } from './GithubConfigPanel';

interface PluginDef {
  id: string;
  name: string;
  description: string;
  icon: string;
  iconBg: string;
  source: 'platform' | 'service';
  status: 'active' | 'configured' | 'available';
  statusLabel: string;
}

interface ServiceState {
  manifest: { id: string; enablesFeatures: string[] };
  status: 'running' | 'stopped' | 'unknown' | 'error';
}

const PLUGIN_CATALOG: Omit<PluginDef, 'status' | 'statusLabel'>[] = [
  {
    id: 'github',
    name: 'GitHub',
    description: 'PR 追踪、Review 投递、CI/CD 监控、Token 和 Noise 过滤',
    icon: 'git-branch',
    iconBg: '#24292e',
    source: 'platform',
  },
];

const STATUS_BADGE: Record<string, { bg: string; text: string }> = {
  active: { bg: 'bg-conn-emerald-bg', text: 'text-conn-emerald-text' },
  configured: { bg: 'bg-conn-amber-bg', text: 'text-conn-amber-text' },
  available: { bg: 'bg-cafe-surface-sunken', text: 'text-cafe-muted' },
};

const SERVICE_FEATURE_MAP: Record<string, string[]> = {};

export function resolvePluginStatuses(services: ServiceState[], apiReachable: boolean): PluginDef[] {
  const runningFeatures = new Set<string>();
  const knownFeatures = new Set<string>();
  for (const svc of services) {
    for (const f of svc.manifest.enablesFeatures) {
      knownFeatures.add(f);
      if (svc.status === 'running') runningFeatures.add(f);
    }
  }

  return PLUGIN_CATALOG.map((p) => {
    if (p.source === 'platform') {
      if (apiReachable) return { ...p, status: 'active' as const, statusLabel: '已连接' };
      return { ...p, status: 'available' as const, statusLabel: 'API 不可达' };
    }

    const features = SERVICE_FEATURE_MAP[p.id] ?? [];
    const hasRunning = features.some((f) => runningFeatures.has(f));
    const hasKnown = features.some((f) => knownFeatures.has(f));

    if (hasRunning) return { ...p, status: 'active' as const, statusLabel: '已连接' };
    if (hasKnown) return { ...p, status: 'configured' as const, statusLabel: '已配置' };
    return { ...p, status: 'available' as const, statusLabel: '未连接' };
  });
}

export function PluginsContent() {
  const [plugins, setPlugins] = useState<PluginDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const resolveStatus = useCallback(async () => {
    try {
      const res = await apiFetch('/api/services');
      if (res.ok) {
        const data = (await res.json()) as { services: ServiceState[] };
        setPlugins(resolvePluginStatuses(data.services, true));
      } else {
        setPlugins(resolvePluginStatuses([], false));
      }
    } catch {
      setPlugins(resolvePluginStatuses([], false));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void resolveStatus();
  }, [resolveStatus]);

  if (loading) return <p className="text-sm text-cafe-muted">加载中...</p>;

  return (
    <div className="flex flex-col gap-3.5" data-testid="plugins-list">
      {plugins.map((plugin) => {
        const badge = STATUS_BADGE[plugin.status];
        const isExpanded = expandedId === plugin.id;
        return (
          <article key={plugin.id} className={settingsResourceCardClass}>
            {plugin.source === 'service' ? (
              <div className={`${settingsResourceRowClass} w-full`}>
                <div className={settingsResourceAvatarClass} style={{ backgroundColor: plugin.iconBg }}>
                  <HubIcon name={plugin.icon} className="h-5 w-5 text-[var(--cafe-surface)]" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-cafe">{plugin.name}</p>
                  <p className="mt-0.5 text-xs text-cafe-secondary">{plugin.description}</p>
                  <p className="mt-0.5 text-label text-cafe-muted">扩展服务 · 在「系统」标签管理</p>
                </div>
                <div className={settingsResourceActionGroupClass}>
                  <span
                    className={`flex-shrink-0 rounded-[13px] px-2.5 py-0.5 text-label font-medium ${badge.bg} ${badge.text}`}
                  >
                    {plugin.statusLabel}
                  </span>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className={`${settingsResourceRowClass} w-full text-left`}
                onClick={() => setExpandedId(isExpanded ? null : plugin.id)}
              >
                <div className={settingsResourceAvatarClass} style={{ backgroundColor: plugin.iconBg }}>
                  <HubIcon name={plugin.icon} className="h-5 w-5 text-[var(--cafe-surface)]" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-cafe">{plugin.name}</p>
                  <p className="mt-0.5 text-xs text-cafe-secondary">{plugin.description}</p>
                  <p className="mt-0.5 text-label text-cafe-muted">内置插件</p>
                </div>
                <div className={settingsResourceActionGroupClass}>
                  <span
                    className={`flex-shrink-0 rounded-[13px] px-2.5 py-0.5 text-label font-medium ${badge.bg} ${badge.text}`}
                  >
                    {plugin.statusLabel}
                  </span>
                </div>
              </button>
            )}
            {isExpanded && plugin.id === 'github' && <GithubConfigPanel />}
          </article>
        );
      })}
    </div>
  );
}
