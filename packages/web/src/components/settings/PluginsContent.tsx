'use client';

import type { PluginInfo, PluginStatus } from '@cat-cafe/shared';
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
import { PluginConfigPanel } from './PluginConfigPanel';
import { SettingsBadge } from './primitives/SettingsBadge';
import { SettingsText } from './primitives/SettingsText';

type BadgeTone = 'emerald' | 'amber' | 'slate' | 'red' | 'purple' | 'blue';
const STATUS_CONFIG: Record<PluginStatus, { label: string; tone: BadgeTone }> = {
  enabled: { label: '已启用', tone: 'emerald' },
  configured: { label: '已配置', tone: 'amber' },
  partial: { label: '部分启用', tone: 'amber' },
  not_configured: { label: '未配置', tone: 'slate' },
};

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

export function PluginsContent() {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

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
      setTogglingId(plugin.id);
      try {
        await apiFetch(`/api/plugins/${plugin.id}/${action}`, { method: 'POST' });
        await fetchPlugins();
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
      <SettingsText as="p" variant="sm" tone="muted">
        加载中...
      </SettingsText>
    );
  }

  if (plugins.length === 0) {
    return (
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
          暂无已安装的插件
        </SettingsText>
        <SettingsText as="p" tone="muted" className="mt-1">
          插件在 plugins/ 目录下管理
        </SettingsText>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3.5" data-testid="plugins-list">
      {plugins.map((plugin) => {
        const statusCfg = STATUS_CONFIG[plugin.status];
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
                {/* Show status badge only when toggle doesn't already communicate the state.
                    "已配置"/"未配置" are informative; "已启用" is redundant with the toggle. */}
                {!(showResourceToggle && isRuntimeEnabled) && (
                  <SettingsBadge tone={statusCfg.tone} className="shrink-0 font-medium">
                    {statusCfg.label}
                  </SettingsBadge>
                )}
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
