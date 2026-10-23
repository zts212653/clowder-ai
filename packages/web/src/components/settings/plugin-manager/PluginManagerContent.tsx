'use client';

import { pluginDescriptionVariants } from '@cat-cafe/shared';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { HubIcon } from '../../hub-icons';
import { settingsResourceCardClass } from '../../SettingsResourceCard';
import { useShellLanguage } from '../../shell/shell-language';
import { SettingsText } from '../primitives/SettingsText';
import { SettingsPageHeader, type SettingsPageHeaderProps } from '../SettingsPageHeader';
import { PluginManagerToolbar } from './controls/PluginManagerToolbar';
import { pluginManagerText } from './controls/plugin-manager.shell-copy';
import { PluginManagerDetailCard } from './PluginManagerDetailCard';
import { PluginListRow, PluginListSection } from './PluginManagerList';
import { PluginManagerNotices } from './PluginManagerNotices';
import { installedPluginGroups, type PluginManagerPresentation } from './plugin-manager-attention';
import type { PluginManagerDesignFixture } from './plugin-manager-fixtures';

function blockedEnableReason(plugin: PluginManagerDesignFixture, locale: string) {
  if (plugin.actions?.blockingReasons.includes('package-incompatible'))
    return pluginManagerText(locale).incompatibleHint;
  if (plugin.id !== 'official.chatgpt-dot') return '请先完成右侧配置或连接，再启用。';
  return plugin.auth === 'connected'
    ? '还在等待 dot 读原文并回帖；两处都完成后才能开启。'
    : '请先完成订阅和两处往返验证，再启用 dot。';
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
  pageHeader,
  catalogStatus = 'fresh',
  catalogMessage,
  loading = false,
  error,
  warning,
  busyPluginId = null,
  selectedPluginId,
  linkedPluginId = null,
  initialDetailPluginId,
  onOperationChange,
  presentation = 'v1',
  onPluginSelect,
  onSearchChange,
  onInstall,
  onMarketplaceChange,
  onDirectoryInstall,
  onSetEnabled,
  onRepair,
  onRequestEnable,
  onUninstall,
  onConfigure,
  configurationSavedPluginId = null,
  onStateChanged,
  locale: requestedLocale,
  renderCompatibilityDetail,
}: {
  fixtures: readonly PluginManagerDesignFixture[];
  pageHeader?: Omit<SettingsPageHeaderProps, 'children'>;
  catalogStatus?: 'loading' | 'fresh' | 'stale' | 'degraded' | 'unavailable';
  catalogMessage?: string;
  loading?: boolean;
  error?: string | null;
  warning?: string | null;
  busyPluginId?: string | null;
  selectedPluginId?: string | null;
  linkedPluginId?: string | null;
  initialDetailPluginId?: string | null;
  onOperationChange?: (pluginId: string) => void;
  presentation?: PluginManagerPresentation;
  onPluginSelect?: (pluginId: string | null) => void;
  onSearchChange?: (query: string) => void;
  onInstall?: (pluginId: string) => void;
  onMarketplaceChange?: () => Promise<void>;
  onDirectoryInstall?: (path: string) => Promise<void>;
  onSetEnabled?: (pluginId: string, enabled: boolean) => void;
  onRepair?: (pluginId: string) => void;
  onRequestEnable?: (pluginId: string) => void | Promise<void>;
  onUninstall?: (pluginId: string) => void;
  onConfigure?: (pluginId: string, updates: readonly { key: string; value: string | null }[]) => void;
  configurationSavedPluginId?: string | null;
  onStateChanged?: () => void | Promise<void>;
  locale?: string;
  renderCompatibilityDetail?: (pluginId: string, plugin: PluginManagerDesignFixture) => ReactNode | undefined;
}) {
  const language = useShellLanguage();
  const locale = requestedLocale ?? (presentation === 'v2' && language === 'en' ? 'en' : 'zh-CN');
  const t = pluginManagerText(locale);
  const initialDetailOpened = useRef(false);
  const [query, setQuery] = useState('');
  const [availableLimit, setAvailableLimit] = useState(5);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [configurationValidation, setConfigurationValidation] = useState({ pluginId: '', request: 0 });

  const filtered = useMemo(() => fixtures.filter((plugin) => matchesSearch(plugin, query)), [fixtures, query]);
  const leadingGroups = installedPluginGroups(filtered, presentation, locale);
  const recommendationPool = filtered.filter(
    (plugin) => plugin.artifact === 'absent' && (presentation === 'v2' || plugin.source === 'catalog'),
  );
  const recommendedPlugins = query.trim() ? recommendationPool : recommendationPool.slice(0, availableLimit);
  const hasMore = !query.trim() && recommendedPlugins.length < recommendationPool.length;
  const otherPlugins = filtered.filter(
    (plugin) => presentation === 'v1' && plugin.artifact === 'absent' && plugin.source !== 'catalog',
  );
  const visible = [...leadingGroups.flatMap((group) => group.plugins), ...recommendationPool, ...otherPlugins];
  const selection = usePluginSelection(visible, selectedPluginId, onPluginSelect);
  const selected = selection.selected;
  const requestEnable = (plugin: PluginManagerDesignFixture) => {
    selection.select(plugin.id);
    setMobileDetailOpen(true);
    setConfigurationValidation((current) => ({ pluginId: plugin.id, request: current.request + 1 }));
    if (onRequestEnable) void onRequestEnable(plugin.id);
    else void onStateChanged?.();
  };
  useEffect(() => {
    if (!initialDetailOpened.current && selected && (initialDetailPluginId ?? linkedPluginId) === selected.id) {
      initialDetailOpened.current = true;
      setMobileDetailOpen(true);
    }
  }, [initialDetailPluginId, linkedPluginId, selected?.id]);

  const renderRows = (plugins: readonly PluginManagerDesignFixture[]) =>
    plugins.map((plugin) => (
      <PluginListRow
        key={plugin.id}
        plugin={plugin}
        presentation={presentation}
        selected={plugin.id === selected?.id}
        locale={locale}
        onSelect={() => {
          selection.select(plugin.id);
          setMobileDetailOpen(true);
        }}
        onInstall={() => onInstall?.(plugin.id)}
        onRepair={onRepair ? () => onRepair(plugin.id) : undefined}
        onSetEnabled={(enabled) => onSetEnabled?.(plugin.id, enabled)}
        onBlockedToggle={() => requestEnable(plugin)}
        onUninstall={() => onUninstall?.(plugin.id)}
        busy={busyPluginId === plugin.id}
        enableBlockedReason={
          configurationValidation.pluginId === plugin.id && plugin.actions?.setEnabled === false
            ? blockedEnableReason(plugin, locale)
            : undefined
        }
      />
    ));

  return (
    <section data-testid="plugin-manager" className="flex h-full min-h-0 flex-1 flex-col gap-3.5 overflow-hidden">
      {pageHeader ? (
        <SettingsPageHeader {...pageHeader}>
          <PluginManagerToolbar
            locale={locale}
            onMarketplaceChange={onMarketplaceChange}
            onDirectoryInstall={onDirectoryInstall}
            onArchiveInstalled={onStateChanged}
          />
        </SettingsPageHeader>
      ) : (
        <PluginManagerToolbar
          locale={locale}
          onMarketplaceChange={onMarketplaceChange}
          onDirectoryInstall={onDirectoryInstall}
          onArchiveInstalled={onStateChanged}
        />
      )}

      <PluginManagerNotices
        catalogStatus={catalogStatus}
        catalogMessage={catalogMessage}
        error={error}
        warning={warning}
      />

      <div className="grid min-h-0 flex-1 gap-3.5 overflow-hidden lg:grid-cols-[minmax(17rem,0.82fr)_minmax(0,1.5fr)]">
        <div
          data-mobile-panel="list"
          className={`${mobileDetailOpen ? 'hidden' : 'flex'} min-h-0 min-w-0 flex-col gap-2 lg:flex`}
        >
          <div>
            <label className={`${settingsResourceCardClass} flex min-w-0 items-center gap-2 px-3 py-2.5`}>
              <HubIcon name="search" className="h-4 w-4 shrink-0 text-cafe-muted" />
              <input
                aria-label={t.search}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setAvailableLimit(5);
                  onSearchChange?.(event.target.value);
                }}
                placeholder={t.search}
                className="min-w-0 flex-1 bg-transparent text-sm text-cafe outline-none placeholder:text-cafe-muted"
              />
            </label>
          </div>
          {/* Keep absolute accessibility labels inside this scroll container's containing block. */}
          <div
            data-plugin-scroll-region="list"
            className="relative min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain pr-1"
            onScroll={(event) => {
              const list = event.currentTarget;
              if (hasMore && list.scrollHeight - list.scrollTop - list.clientHeight < 96)
                setAvailableLimit((limit) => limit + 5);
            }}
          >
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
                {leadingGroups.map(({ kind, title, ariaLabel, plugins }) => (
                  <PluginListSection
                    key={kind}
                    kind={kind}
                    title={title}
                    ariaLabel={ariaLabel}
                    rows={renderRows(plugins)}
                    count={presentation === 'v2' ? plugins.length : undefined}
                  />
                ))}
                <PluginListSection
                  kind={presentation === 'v2' ? 'available' : 'recommended'}
                  title={presentation === 'v2' ? t.availableGroup : locale.startsWith('en') ? t.recommended : '推荐'}
                  ariaLabel={presentation === 'v2' ? t.availableGroup : t.recommended}
                  rows={renderRows(recommendedPlugins)}
                  count={presentation === 'v2' ? recommendationPool.length : undefined}
                />
                {hasMore && (
                  <button
                    type="button"
                    onClick={() => setAvailableLimit((limit) => limit + 5)}
                    className="console-inline-link w-full py-2 text-sm"
                  >
                    {t.viewMore}
                  </button>
                )}
                {presentation === 'v1' && (
                  <PluginListSection kind="other" title="其他" ariaLabel="其他插件" rows={renderRows(otherPlugins)} />
                )}
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
          <div
            data-plugin-scroll-region="detail"
            className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1"
          >
            {selected ? (
              (renderCompatibilityDetail?.(selected.id, selected) ?? (
                <PluginManagerDetailCard
                  key={selected.id}
                  plugin={selected}
                  presentation={presentation}
                  onOperationChange={() => onOperationChange?.(selected.id)}
                  locale={locale}
                  busy={busyPluginId === selected.id}
                  onInstall={onInstall ? () => onInstall(selected.id) : undefined}
                  onRepair={onRepair ? () => onRepair(selected.id) : undefined}
                  onUninstall={onUninstall ? () => onUninstall(selected.id) : undefined}
                  onSetEnabled={onSetEnabled ? (enabled) => onSetEnabled(selected.id, enabled) : undefined}
                  onBlockedToggle={() => requestEnable(selected)}
                  configurationValidationRequest={
                    configurationValidation.pluginId === selected.id ? configurationValidation.request : 0
                  }
                  configurationSaved={configurationSavedPluginId === selected.id}
                  onStateChanged={onStateChanged}
                  onSaveConfig={
                    selected.configFields?.length ? (updates) => onConfigure?.(selected.id, updates) : undefined
                  }
                />
              ))
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
