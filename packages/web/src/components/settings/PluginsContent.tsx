'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { HubIcon } from '../hub-icons';

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
    id: 'pr-tracking',
    name: 'GitHub PR Tracking',
    description: '自动追踪 PR 状态、review 结果、合并进度',
    icon: 'zap',
    iconBg: '#24292e',
    source: 'platform',
  },
  {
    id: 'review-router',
    name: 'Review Feedback Router',
    description: 'Review decisions 和 inline comments 自动投递到对应猫的工作线程',
    icon: 'message-circle',
    iconBg: '#6f42c1',
    source: 'platform',
  },
  {
    id: 'ci-cd-monitor',
    name: 'CI/CD Monitor',
    description: 'GitHub Actions 运行状态监控，失败时自动通知相关猫排查',
    icon: 'activity',
    iconBg: '#0969da',
    source: 'platform',
  },
  {
    id: 'voice-companion',
    name: '语音陪伴',
    description: '语音输入/输出和实时陪伴对话模式',
    icon: 'mic',
    iconBg: '#d4764e',
    source: 'service',
  },
  {
    id: 'browser-automation',
    name: 'Browser Automation',
    description: '通过 Chrome MCP 进行浏览器自动化操作和 UI 验证',
    icon: 'puzzle',
    iconBg: '#0f9d58',
    source: 'service',
  },
];

const STATUS_BADGE: Record<string, { bg: string; text: string }> = {
  active: { bg: 'bg-conn-emerald-bg', text: 'text-conn-emerald-text' },
  configured: { bg: 'bg-conn-amber-bg', text: 'text-conn-amber-text' },
  available: { bg: 'bg-cafe-surface-sunken', text: 'text-cafe-muted' },
};

const SERVICE_FEATURE_MAP: Record<string, string[]> = {
  'voice-companion': ['voice-input', 'voice-output', 'voice-companion'],
  'browser-automation': ['browser-automation-mcp'],
};

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

  const resolveStatus = useCallback(async () => {
    let services: ServiceState[] = [];
    let apiReachable = false;
    try {
      const res = await apiFetch('/api/services');
      if (res.ok) {
        apiReachable = true;
        const data = (await res.json()) as { services: ServiceState[] };
        services = data.services;
      }
    } catch {
      /* unavailable */
    }

    setPlugins(resolvePluginStatuses(services, apiReachable));
    setLoading(false);
  }, []);

  useEffect(() => {
    resolveStatus();
  }, [resolveStatus]);

  if (loading) return <p className="text-sm text-cafe-muted">加载中...</p>;

  return (
    <div className="flex flex-col gap-3.5" data-testid="plugins-list">
      {plugins.map((plugin) => {
        const badge = STATUS_BADGE[plugin.status];
        return (
          <article
            key={plugin.id}
            className="flex h-24 items-center gap-4 rounded-2xl bg-[var(--console-card-bg)] px-5 py-[18px] shadow-[0_8px_24px_rgba(43,33,26,0.05)] transition-shadow hover:shadow-[0_12px_30px_rgba(43,33,26,0.08)]"
          >
            <div
              className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-[12px]"
              style={{ backgroundColor: plugin.iconBg }}
            >
              <HubIcon name={plugin.icon} className="h-5 w-5 text-[var(--cafe-surface)]" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[15px] font-extrabold text-cafe">{plugin.name}</p>
              <p className="mt-0.5 text-xs text-cafe-secondary">{plugin.description}</p>
              <p className="mt-0.5 text-[11px] text-cafe-muted">
                {plugin.source === 'platform' ? '内置插件' : '扩展服务'}
              </p>
            </div>
            <span
              className={`flex-shrink-0 rounded-[13px] px-2.5 py-0.5 text-[11px] font-medium ${badge.bg} ${badge.text}`}
            >
              {plugin.statusLabel}
            </span>
          </article>
        );
      })}
    </div>
  );
}
