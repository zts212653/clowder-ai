'use client';

import type { PluginInfo } from '@cat-cafe/shared';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { HubIcon } from '../hub-icons';
import { GitHubIcon } from '../icons/ConnectorIcons';
import {
  SettingsResourceToggleSwitch,
  settingsResourceActionGroupClass,
  settingsResourceAvatarClass,
  settingsResourceCardClass,
  settingsResourceRowClass,
} from '../SettingsResourceCard';
import { OfficialPluginsPanel } from './OfficialPluginsPanel';
import { PersonalChromePluginPanel } from './PersonalChromePluginPanel';
import { PluginConfigPanel } from './PluginConfigPanel';
import { SettingsBadge } from './primitives/SettingsBadge';
import { SettingsText } from './primitives/SettingsText';

const BUILTIN_GITHUB_PLUGIN: PluginInfo = {
  id: 'github',
  name: 'GitHub',
  version: '1.0.0',
  description: '内置插件 · PR 追踪、Review 投递、CI/CD 监控与 GitHub CLI 认证',
  icon: 'github',
  iconBg: '#24292e',
  docsUrl: 'https://cli.github.com/manual/gh_auth_login',
  setupSteps: ['在运行 Clowder AI 的机器上执行 gh auth login', '可选：仅在需要显式覆盖 gh 登录态时配置插件 token'],
  status: 'configured',
  configured: true,
  config: [],
  resources: [],
  hasHealthCheck: false,
};

function pluginToggleFailure(data: { status?: string; error?: string }, actionLabel: string): string | undefined {
  if (data.status === 'partial') return data.error ?? `插件${actionLabel}部分成功`;
  if (data.status === 'failed') return data.error ?? `插件${actionLabel}失败`;
  return undefined;
}

export function PluginsContent() {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);

  const fetchPlugins = useCallback(async () => {
    try {
      const res = await apiFetch('/api/plugins');
      const payload = res.ok ? ((await res.json()) as { plugins?: PluginInfo[] }) : {};
      setPlugins(Array.isArray(payload.plugins) ? payload.plugins : [BUILTIN_GITHUB_PLUGIN]);
    } catch {
      setPlugins([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleToggle = useCallback(
    async (plugin: PluginInfo) => {
      const isEnabled = plugin.status === 'enabled' || plugin.status === 'partial';
      const action = isEnabled ? 'disable' : 'enable';
      const actionLabel = action === 'enable' ? '启用' : '禁用';
      setTogglingId(plugin.id);
      setToggleError(null);
      try {
        const res = await apiFetch(`/api/plugins/${plugin.id}/${action}`, { method: 'POST' });
        if (!res.ok) {
          setToggleError(`插件${actionLabel}失败 (${res.status})`);
          return;
        }
        const data = (await res.json().catch(() => ({}))) as { status?: string; error?: string };
        const failure = pluginToggleFailure(data, actionLabel);
        if (failure) setToggleError(failure);
        await fetchPlugins();
      } catch {
        setToggleError('网络错误');
      } finally {
        setTogglingId(null);
      }
    },
    [fetchPlugins],
  );

  useEffect(() => {
    void fetchPlugins();
  }, [fetchPlugins]);

  if (loading) {
    return (
      <div className="flex flex-col gap-3.5" data-testid="plugins-list">
        <PersonalChromePluginPanel />
        <OfficialPluginsPanel />
        <SettingsText as="p" variant="sm" tone="muted">
          加载本地插件中...
        </SettingsText>
      </div>
    );
  }

  if (plugins.length === 0) {
    return (
      <div className="flex flex-col gap-3.5" data-testid="plugins-list">
        <PersonalChromePluginPanel />
        <OfficialPluginsPanel />
        <div
          className="flex flex-col items-center justify-center"
          style={{
            borderRadius: '1rem',
            background: 'var(--console-card-bg)',
            padding: '4rem 2rem',
            textAlign: 'center',
          }}
        >
          <span className="mb-3 opacity-40" style={{ color: 'var(--cafe-text-muted)' }}>
            <HubIcon name="blocks" className="h-10 w-10" />
          </span>
          <SettingsText as="p" variant="sm" tone="default" className="font-semibold">
            暂无本地插件
          </SettingsText>
          <SettingsText as="p" tone="muted" className="mt-1">
            本地插件在 plugins/ 目录下管理
          </SettingsText>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3.5" data-testid="plugins-list">
      <PersonalChromePluginPanel />
      <OfficialPluginsPanel />
      {toggleError && (
        <div className="rounded-md bg-conn-red-bg px-3 py-2 text-sm text-conn-red-text">{toggleError}</div>
      )}
      {plugins.map((plugin) => {
        const isExpanded = expandedId === plugin.id;
        const isRuntimeEnabled = plugin.status === 'enabled' || plugin.status === 'partial';
        const showResourceToggle = plugin.resources.length > 0 && (plugin.configured || isRuntimeEnabled);

        return (
          <article key={plugin.id} className={settingsResourceCardClass}>
            <div className={`${settingsResourceRowClass} w-full`}>
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-3"
                style={{ textAlign: 'left' }}
                onClick={() => setExpandedId(isExpanded ? null : plugin.id)}
              >
                <div
                  className={settingsResourceAvatarClass}
                  style={{ backgroundColor: plugin.iconBg ?? '#9ca3af', color: 'var(--cafe-surface)' }}
                >
                  {plugin.icon === 'github' ? (
                    <GitHubIcon className="h-5 w-5" color="var(--cafe-surface)" />
                  ) : (
                    <HubIcon name={plugin.icon ?? 'blocks'} className="h-5 w-5" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <SettingsText as="p" variant="sm" tone="default" className="font-semibold">
                    {plugin.name}
                  </SettingsText>
                  {plugin.description && (
                    <SettingsText as="p" tone="secondary" className="mt-0.5">
                      {plugin.description}
                    </SettingsText>
                  )}
                </div>
              </button>
              <div className={settingsResourceActionGroupClass}>
                {/* Config status badge — always visible, purely reflects whether
                    credentials/config are present. Toggle independently shows on/off. */}
                <SettingsBadge tone={plugin.configured ? 'amber' : 'slate'} className="shrink-0 font-medium">
                  {plugin.configured ? '已配置' : '未配置'}
                </SettingsBadge>
                {showResourceToggle && (
                  <SettingsResourceToggleSwitch
                    enabled={isRuntimeEnabled}
                    busy={togglingId === plugin.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleToggle(plugin);
                    }}
                  />
                )}
              </div>
            </div>

            {isExpanded && <PluginConfigPanel plugin={plugin} onUpdated={fetchPlugins} />}
          </article>
        );
      })}
    </div>
  );
}
