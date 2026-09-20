'use client';

import { pluginDescriptionVariants } from '@cat-cafe/shared';
import { useEffect, useMemo, useState } from 'react';
import { ConnectorPluginInstallButton } from '../../ConnectorPluginInstallButton';
import { HubIcon } from '../../hub-icons';
import { settingsResourceCardClass } from '../../SettingsResourceCard';
import { SettingsText } from '../primitives/SettingsText';
import { PluginManagerDetailCard } from './PluginManagerDetailCard';
import { PluginListRow, PluginListSection } from './PluginManagerList';
import type { PluginManagerDesignFixture } from './plugin-manager-fixtures';

const DEFAULT_RECOMMENDATION_LIMIT = 3;

function PluginManagerError({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return (
    <div role="alert" className="rounded-xl bg-conn-red-bg px-3 py-2.5 text-sm text-conn-red-text">
      {message}
    </div>
  );
}

function matchesSearch(plugin: PluginManagerDesignFixture, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized.length === 0) return true;
  return `${plugin.id} ${plugin.displayName} ${pluginDescriptionVariants(plugin.description).join(' ')} ${plugin.packageName} ${plugin.publisher} ${plugin.capabilities
    .map((capability) => `${capability.name} ${capability.description}`)
    .join(' ')}`
    .toLocaleLowerCase()
    .includes(normalized);
}

function usePluginSelection(
  visible: readonly PluginManagerDesignFixture[],
  controlledSelectedId: string | null | undefined,
  onPluginSelect: ((pluginId: string | null) => void) | undefined,
) {
  const [internalSelectedId, setInternalSelectedId] = useState(visible[0]?.id ?? '');
  const requestedSelectedId = controlledSelectedId === undefined ? internalSelectedId : controlledSelectedId;
  const selected = visible.find((plugin) => plugin.id === requestedSelectedId) ?? visible[0] ?? null;
  const effectiveSelectedId = selected?.id ?? null;

  useEffect(() => {
    if (controlledSelectedId === undefined) {
      if (effectiveSelectedId !== internalSelectedId) setInternalSelectedId(effectiveSelectedId ?? '');
      return;
    }
    if (effectiveSelectedId !== controlledSelectedId) onPluginSelect?.(effectiveSelectedId);
  }, [controlledSelectedId, effectiveSelectedId, internalSelectedId, onPluginSelect]);

  return {
    selected,
    select: (pluginId: string) => {
      if (controlledSelectedId === undefined) setInternalSelectedId(pluginId);
      onPluginSelect?.(pluginId);
    },
  };
}

export function PluginManagerContent({
  fixtures,
  catalogStatus = 'fresh',
  catalogMessage,
  loading = false,
  error,
  busyPluginId = null,
  selectedPluginId,
  onPluginSelect,
  onSearchChange,
  onInstall,
  onSetEnabled,
  onUninstall,
  onConfigure,
  configurationSavedPluginId = null,
  locale = 'zh-CN',
}: {
  fixtures: readonly PluginManagerDesignFixture[];
  catalogStatus?: 'fresh' | 'stale' | 'degraded' | 'unavailable';
  catalogMessage?: string;
  loading?: boolean;
  error?: string | null;
  busyPluginId?: string | null;
  selectedPluginId?: string | null;
  onPluginSelect?: (pluginId: string | null) => void;
  onSearchChange?: (query: string) => void;
  onInstall?: (pluginId: string) => void;
  onSetEnabled?: (pluginId: string, enabled: boolean) => void;
  onUninstall?: (pluginId: string) => void;
  onConfigure?: (pluginId: string, updates: readonly { key: string; value: string | null }[]) => void;
  configurationSavedPluginId?: string | null;
  locale?: string;
}) {
  const [query, setQuery] = useState('');
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [configurationValidation, setConfigurationValidation] = useState({ pluginId: '', request: 0 });

  const filtered = useMemo(() => fixtures.filter((plugin) => matchesSearch(plugin, query)), [fixtures, query]);
  const installedPlugins = filtered.filter((plugin) => plugin.artifact === 'installed');
  const recommendationPool = filtered.filter((plugin) => plugin.artifact === 'absent' && plugin.source === 'catalog');
  const recommendedPlugins =
    query.trim().length > 0 ? recommendationPool : recommendationPool.slice(0, DEFAULT_RECOMMENDATION_LIMIT);
  const attentionPlugins = filtered.filter((plugin) => plugin.artifact !== 'installed' && plugin.artifact !== 'absent');
  const otherPlugins = filtered.filter((plugin) => plugin.artifact === 'absent' && plugin.source !== 'catalog');
  const visible = [...installedPlugins, ...attentionPlugins, ...recommendedPlugins, ...otherPlugins];
  const selection = usePluginSelection(visible, selectedPluginId, onPluginSelect);
  const selected = selection.selected;

  const renderRows = (plugins: readonly PluginManagerDesignFixture[]) =>
    plugins.map((plugin) => (
      <PluginListRow
        key={plugin.id}
        plugin={plugin}
        selected={plugin.id === selected?.id}
        locale={locale}
        onSelect={() => {
          selection.select(plugin.id);
          setMobileDetailOpen(true);
        }}
        onInstall={() => onInstall?.(plugin.id)}
        onSetEnabled={(enabled) => onSetEnabled?.(plugin.id, enabled)}
        onBlockedToggle={() => {
          selection.select(plugin.id);
          setMobileDetailOpen(true);
          setConfigurationValidation((current) => ({ pluginId: plugin.id, request: current.request + 1 }));
        }}
        onUninstall={() => onUninstall?.(plugin.id)}
        busy={busyPluginId === plugin.id}
      />
    ));

  return (
    <section data-testid="plugin-manager" className="flex h-full min-h-0 flex-1 flex-col gap-3.5 overflow-hidden">
      <div data-plugin-manager-toolbar className="flex justify-end">
        <ConnectorPluginInstallButton
          endpoint="/api/plugin-manager/plugins/install/upload"
          label="离线安装"
          docsHref={false}
        />
      </div>

      {catalogStatus !== 'fresh' && (
        <div className="flex items-start gap-2 rounded-xl bg-conn-amber-bg px-3 py-2.5">
          <HubIcon name="alert-triangle" className="mt-0.5 h-4 w-4 shrink-0 text-conn-amber-text" />
          <SettingsText as="p" variant="sm" tone="amber">
            {catalogMessage ?? '目录暂时不可用；已安装插件仍可管理，未安装列表会在连接恢复后刷新。'}
          </SettingsText>
        </div>
      )}

      <PluginManagerError message={error} />

      <div className="grid min-h-0 flex-1 gap-3.5 overflow-hidden lg:grid-cols-[minmax(17rem,0.82fr)_minmax(0,1.5fr)]">
        <div
          data-mobile-panel="list"
          className={`${mobileDetailOpen ? 'hidden' : 'flex'} min-h-0 min-w-0 flex-col gap-2 lg:flex`}
        >
          <div>
            <label className={`${settingsResourceCardClass} flex min-w-0 items-center gap-2 px-3 py-2.5`}>
              <HubIcon name="search" className="h-4 w-4 shrink-0 text-cafe-muted" />
              <input
                aria-label="搜索插件"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  onSearchChange?.(event.target.value);
                }}
                placeholder="搜索插件"
                className="min-w-0 flex-1 bg-transparent text-sm text-cafe outline-none placeholder:text-cafe-muted"
              />
            </label>
          </div>
          <div data-plugin-scroll-region="list" className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
            {loading && (
              <div data-testid="plugin-manager-loading" className="space-y-2">
                {[0, 1, 2].map((item) => (
                  <div key={item} className={`${settingsResourceCardClass} h-[88px] animate-pulse`} />
                ))}
              </div>
            )}
            {!loading && filtered.length === 0 && (
              <div className={`${settingsResourceCardClass} px-4 py-10 text-center`}>
                <SettingsText as="p" variant="sm" tone="muted">
                  没有符合条件的插件
                </SettingsText>
              </div>
            )}
            {!loading && (
              <>
                <PluginListSection
                  kind="installed"
                  title="已安装"
                  ariaLabel="已安装插件"
                  rows={renderRows(installedPlugins)}
                />
                <PluginListSection
                  kind="attention"
                  title="需要处理"
                  ariaLabel="需要处理的插件"
                  rows={renderRows(attentionPlugins)}
                />
                <PluginListSection
                  kind="recommended"
                  title="推荐"
                  ariaLabel="推荐插件"
                  rows={renderRows(recommendedPlugins)}
                />
                <PluginListSection kind="other" title="其他" ariaLabel="其他插件" rows={renderRows(otherPlugins)} />
              </>
            )}
          </div>
        </div>

        <div
          data-mobile-panel="detail"
          className={`${mobileDetailOpen ? 'flex' : 'hidden'} min-h-0 min-w-0 flex-col gap-2 lg:flex`}
        >
          <button
            type="button"
            onClick={() => setMobileDetailOpen(false)}
            className="flex items-center gap-2 px-1 text-xs font-semibold text-cafe-secondary transition hover:text-cafe lg:hidden"
          >
            <HubIcon name="arrow-left" className="h-4 w-4" />
            返回插件列表
          </button>
          <div data-plugin-scroll-region="detail" className="min-h-0 flex-1 overflow-y-auto pr-1">
            {selected ? (
              <PluginManagerDetailCard
                key={selected.id}
                plugin={selected}
                locale={locale}
                busy={busyPluginId === selected.id}
                configurationValidationRequest={
                  configurationValidation.pluginId === selected.id ? configurationValidation.request : 0
                }
                configurationSaved={configurationSavedPluginId === selected.id}
                onSaveConfig={
                  selected.configFields?.length ? (updates) => onConfigure?.(selected.id, updates) : undefined
                }
              />
            ) : loading ? (
              <div className={`${settingsResourceCardClass} min-h-48 animate-pulse`} />
            ) : (
              <div className={`${settingsResourceCardClass} flex min-h-48 items-center justify-center p-6`}>
                <SettingsText as="p" variant="sm" tone="muted">
                  选择一个插件查看详情
                </SettingsText>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
