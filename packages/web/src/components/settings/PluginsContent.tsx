'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { HubIcon } from '../hub-icons';
import {
  settingsResourceAvatarClass,
  settingsResourceCardClass,
  settingsResourceRowClass,
} from '../SettingsResourceCard';
import { GithubConfigPanel } from './GithubConfigPanel';
import { SettingsBadge, SettingsText } from './primitives';
import {
  adaptServiceState,
  adaptServiceToPlugin,
  type HomeServiceState,
  type PluginUiItem,
  type PluginUiStatus,
} from './service-ui-adapter';

type BadgeTone = 'emerald' | 'amber' | 'slate';
const STATUS_BADGE_TONE: Record<PluginUiStatus, BadgeTone> = {
  active: 'emerald',
  configured: 'amber',
  available: 'slate',
};

export function PluginsContent() {
  const [plugins, setPlugins] = useState<PluginUiItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: cancellation guard pattern
    async function fetchServices() {
      setLoading(true);
      setError(null);
      try {
        const res = await apiFetch('/api/services');
        if (cancelled) return;
        if (!res.ok) {
          setError(`服务清单加载失败 (${res.status})`);
          return;
        }
        const payload = (await res.json()) as { services?: unknown };
        if (cancelled) return;
        const list = Array.isArray(payload.services) ? (payload.services as HomeServiceState[]) : [];
        setPlugins(list.map((s) => adaptServiceToPlugin(adaptServiceState(s))));
      } catch {
        if (!cancelled) setError('服务清单加载失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void fetchServices();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-3">
      <article className={settingsResourceCardClass}>
        <button
          type="button"
          className={`${settingsResourceRowClass} w-full`}
          style={{ textAlign: 'left' }}
          onClick={() => setExpandedId(expandedId === 'github' ? null : 'github')}
        >
          <div className={settingsResourceAvatarClass} style={{ backgroundColor: '#24292e' }}>
            <span style={{ color: 'var(--cafe-surface)' }}>
              <HubIcon name="key" className="h-5 w-5" />
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <SettingsText as="p" variant="sm" tone="default" className="font-semibold">
              GitHub
            </SettingsText>
            <SettingsText as="p" tone="secondary" className="mt-0.5">
              PR 追踪、Review 投递、CI/CD 监控与 Token 配置
            </SettingsText>
            <SettingsText as="p" tone="muted" className="mt-0.5">
              内置插件
            </SettingsText>
          </div>
          <SettingsBadge tone="emerald" className="shrink-0 font-bold">
            可配置
          </SettingsBadge>
        </button>
        {expandedId === 'github' && <GithubConfigPanel />}
      </article>

      {loading ? (
        <SettingsText as="p" variant="sm" tone="muted">
          加载中...
        </SettingsText>
      ) : error ? (
        <SettingsText as="p" variant="sm" tone="red">
          {error}
        </SettingsText>
      ) : (
        plugins.map((plugin) => (
          <article key={plugin.id} className={settingsResourceCardClass}>
            <div className={settingsResourceRowClass}>
              <div className={settingsResourceAvatarClass}>{plugin.name.charAt(0).toUpperCase()}</div>
              <div className="min-w-0 flex-1">
                <SettingsText as="p" variant="sm" tone="default" className="font-semibold">
                  {plugin.name}
                </SettingsText>
                <SettingsText as="p" tone="secondary" className="mt-0.5">
                  {plugin.description}
                </SettingsText>
                <SettingsText as="p" tone="muted" className="mt-0.5">
                  扩展服务
                </SettingsText>
              </div>
              <SettingsBadge tone={STATUS_BADGE_TONE[plugin.status]} className="shrink-0 font-bold">
                {plugin.statusLabel}
              </SettingsBadge>
            </div>
            {plugin.features.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pb-3" style={{ paddingInline: '1rem' }}>
                {plugin.features.map((feature) => (
                  <SettingsBadge key={feature} tone="slate" size="xxs">
                    {feature}
                  </SettingsBadge>
                ))}
              </div>
            )}
            {plugin.error && (
              <SettingsText as="p" tone="red" className="pb-3" style={{ paddingInline: '1rem' }}>
                {plugin.error}
              </SettingsText>
            )}
          </article>
        ))
      )}
    </div>
  );
}
