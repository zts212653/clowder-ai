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

interface GitHubField {
  envName: string;
  label: string;
  sensitive: boolean;
  currentValue: string | null;
}

interface GitHubPlatformStatus {
  id: string;
  fields: GitHubField[];
}

interface ConnectorStatusResponse {
  platforms?: GitHubPlatformStatus[];
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
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [githubFields, setGithubFields] = useState<GitHubField[]>([]);
  const [githubValues, setGithubValues] = useState<Record<string, string>>({});
  const [githubSaving, setGithubSaving] = useState(false);
  const [githubSaveResult, setGithubSaveResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

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

  const fetchGithubFields = useCallback(async () => {
    try {
      const res = await apiFetch('/api/connector/status');
      if (!res.ok) return;
      const data = (await res.json()) as ConnectorStatusResponse | GitHubPlatformStatus[];
      const platforms = Array.isArray(data) ? data : (data.platforms ?? []);
      const gh = platforms.find((p) => p.id === 'github');
      setGithubFields(gh?.fields ?? []);
    } catch {
      /* ignore */
    }
  }, []);

  const handleSaveGithubConfig = useCallback(async () => {
    const updates = githubFields
      .filter((field) => githubValues[field.envName] !== undefined)
      .map((field) => ({ name: field.envName, value: githubValues[field.envName] || null }));

    if (updates.length === 0) {
      setGithubSaveResult({ type: 'error', message: '请填写至少一个配置项' });
      return;
    }

    setGithubSaving(true);
    setGithubSaveResult(null);
    try {
      const res = await apiFetch('/api/config/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as Record<string, string>;
        setGithubSaveResult({ type: 'error', message: data.error ?? '保存失败' });
        return;
      }
      setGithubValues({});
      setGithubSaveResult({ type: 'success', message: 'GitHub 配置已保存' });
      await fetchGithubFields();
    } catch {
      setGithubSaveResult({ type: 'error', message: '网络错误' });
    } finally {
      setGithubSaving(false);
    }
  }, [githubFields, githubValues, fetchGithubFields]);

  useEffect(() => {
    resolveStatus();
  }, [resolveStatus]);

  useEffect(() => {
    if (expandedId === 'github' && githubFields.length === 0) fetchGithubFields();
  }, [expandedId, githubFields.length, fetchGithubFields]);

  if (loading) return <p className="text-sm text-cafe-muted">加载中...</p>;

  return (
    <div className="flex flex-col gap-3.5" data-testid="plugins-list">
      {plugins.map((plugin) => {
        const badge = STATUS_BADGE[plugin.status];
        const isExpanded = expandedId === plugin.id;
        return (
          <article key={plugin.id} className={settingsResourceCardClass}>
            <button
              type="button"
              className={`${settingsResourceRowClass} w-full text-left`}
              onClick={() => {
                setExpandedId(isExpanded ? null : plugin.id);
                setGithubSaveResult(null);
              }}
            >
              <div className={settingsResourceAvatarClass} style={{ backgroundColor: plugin.iconBg }}>
                <HubIcon name={plugin.icon} className="h-5 w-5 text-[var(--cafe-surface)]" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[15px] font-extrabold text-cafe">{plugin.name}</p>
                <p className="mt-0.5 text-xs text-cafe-secondary">{plugin.description}</p>
                <p className="mt-0.5 text-[11px] text-cafe-muted">
                  {plugin.source === 'platform' ? '内置插件' : '扩展服务'}
                </p>
              </div>
              <div className={settingsResourceActionGroupClass}>
                <span
                  className={`flex-shrink-0 rounded-[13px] px-2.5 py-0.5 text-[11px] font-medium ${badge.bg} ${badge.text}`}
                >
                  {plugin.statusLabel}
                </span>
              </div>
            </button>
            {isExpanded && plugin.id === 'github' && (
              <div className="border-t border-[var(--console-border)] px-4 py-3">
                <p className="mb-2 text-[12px] font-bold text-cafe-secondary">配置项</p>
                {githubFields.length === 0 ? (
                  <p className="text-[12px] text-cafe-muted">加载配置项...</p>
                ) : (
                  <div className="space-y-2">
                    {githubFields.map((field) => (
                      <div key={field.envName}>
                        <label
                          htmlFor={`plugin-config-${field.envName}`}
                          className="mb-1 block text-xs font-medium text-cafe-secondary"
                        >
                          {field.label}
                        </label>
                        <input
                          id={`plugin-config-${field.envName}`}
                          type={field.sensitive ? 'password' : 'text'}
                          placeholder={
                            field.sensitive
                              ? field.currentValue
                                ? '已设置（输入新值覆盖）'
                                : '未配置'
                              : (field.currentValue ?? '未配置')
                          }
                          value={githubValues[field.envName] ?? ''}
                          onChange={(e) => setGithubValues((prev) => ({ ...prev, [field.envName]: e.target.value }))}
                          className="console-form-input py-2.5 text-[13px]"
                          data-testid={`field-${field.envName}`}
                        />
                      </div>
                    ))}
                    {githubSaveResult && (
                      <div
                        className={`rounded-[16px] px-3 py-2 text-xs ${
                          githubSaveResult.type === 'success'
                            ? 'border border-conn-emerald-ring bg-conn-emerald-bg text-conn-emerald-text'
                            : 'border border-conn-red-ring bg-conn-red-bg text-conn-red-text'
                        }`}
                      >
                        {githubSaveResult.message}
                      </div>
                    )}
                    <div className="flex justify-end">
                      <button
                        type="button"
                        onClick={handleSaveGithubConfig}
                        disabled={githubSaving}
                        className="console-button-primary text-[13px] disabled:opacity-50"
                      >
                        {githubSaving ? '保存中...' : '保存 GitHub 配置'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}
