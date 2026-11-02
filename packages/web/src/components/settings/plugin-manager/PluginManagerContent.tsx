'use client';

import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { HubIcon } from '../../hub-icons';
import { settingsResourceCardClass } from '../../SettingsResourceCard';
import { useShellLanguage } from '../../shell/shell-language';
import { SettingsText } from '../primitives/SettingsText';
import { SettingsPageHeader, type SettingsPageHeaderProps } from '../SettingsPageHeader';
import { PluginManagerToolbar } from './controls/PluginManagerToolbar';
import { PluginBatchPanel } from './PluginBatchPanel';
import { PluginBrowserPanel } from './PluginBrowserPanel';
import { PluginManagerDetailCard } from './PluginManagerDetailCard';
import { PluginListRow } from './PluginManagerList';
import { PluginManagerNotices } from './PluginManagerNotices';
import type { PluginScope } from './PluginScopeMenu';
import { type PluginBatchEntry, pluginBatchEntry } from './plugin-batch-model';
import { pluginBrowserModel } from './plugin-browser-model';
import { type PluginManagerPresentation, pluginBlockedEnableReason } from './plugin-manager-attention';
import type { PluginManagerDesignFixture } from './plugin-manager-fixtures';
import { usePluginBatch } from './usePluginBatch';
import type { PluginCatalogCheckState } from './usePluginCatalogCheck';

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
  catalogCheck,
  onCheckCatalog,
  loading = false,
  inventoryKnown = !loading,
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
  catalogCheck?: PluginCatalogCheckState;
  onCheckCatalog?: () => void;
  loading?: boolean;
  inventoryKnown?: boolean;
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
  const initialDetailOpened = useRef(false);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<PluginScope>('all');
  const batch = usePluginBatch(onStateChanged);
  const [batchEntries, setBatchEntries] = useState<PluginBatchEntry[]>([]);
  const [batchFixtures, setBatchFixtures] = useState<readonly PluginManagerDesignFixture[]>([]);
  const [availableLimit, setAvailableLimit] = useState(5);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [configurationValidation, setConfigurationValidation] = useState({ pluginId: '', request: 0 });

  const modern = presentation === 'v2';
  const unavailable = catalogCheck?.unavailable || catalogStatus === 'unavailable';
  const {
    known,
    attention,
    counts,
    filtered,
    leadingGroups,
    recommendationPool,
    recommendedPlugins,
    hasMore,
    otherPlugins,
    visible,
  } = pluginBrowserModel({
    fixtures: batch.open ? batchFixtures : fixtures,
    presentation,
    locale,
    unavailable: !!unavailable,
    hasCatalogHistory:
      fixtures.some((p) => p.artifact === 'absent') ||
      (catalogCheck?.hasCatalogSnapshot ?? !!catalogCheck?.lastSuccessfulAt),
    scope,
    query,
    availableLimit,
  });
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
          batch.close();
          selection.select(plugin.id);
          setMobileDetailOpen(true);
        }}
        progress={batch.open ? batch.results.find((r) => r.id === plugin.id) : undefined}
        onConfigure={
          modern
            ? () => {
                batch.close();
                selection.select(plugin.id);
                setMobileDetailOpen(true);
                setConfigurationValidation((current) => ({ pluginId: plugin.id, request: current.request + 1 }));
              }
            : undefined
        }
        onInstall={() => onInstall?.(plugin.id)}
        onRepair={onRepair ? () => onRepair(plugin.id) : undefined}
        onSetEnabled={(enabled) => onSetEnabled?.(plugin.id, enabled)}
        onBlockedToggle={() => requestEnable(plugin)}
        onUninstall={() => onUninstall?.(plugin.id)}
        locked={batch.open}
        busy={
          busyPluginId === plugin.id ||
          (batch.open &&
            batch.phase === 'running' &&
            batch.results.some((r) => r.id === plugin.id && r.state === 'working'))
        }
        enableBlockedReason={
          configurationValidation.pluginId === plugin.id && plugin.actions?.setEnabled === false
            ? pluginBlockedEnableReason(plugin, locale, presentation)
            : undefined
        }
      />
    ));

  return (
    <section
      data-testid="plugin-manager"
      className={`flex h-full min-h-0 flex-1 flex-col gap-3.5 overflow-hidden ${batch.open ? 'fixed inset-0 z-50 bg-[var(--console-shell-bg)] p-4 lg:static lg:z-auto lg:bg-transparent lg:p-0' : ''}`}
    >
      <div className={batch.open ? 'hidden lg:block' : undefined}>
        {pageHeader ? (
          <SettingsPageHeader {...pageHeader}>
            <PluginManagerToolbar
              locale={locale}
              autoSynchronize={!modern}
              onMarketplaceChange={onMarketplaceChange}
              onDirectoryInstall={onDirectoryInstall}
              onArchiveInstalled={onStateChanged}
            />
          </SettingsPageHeader>
        ) : (
          <PluginManagerToolbar
            locale={locale}
            autoSynchronize={!modern}
            onMarketplaceChange={onMarketplaceChange}
            onDirectoryInstall={onDirectoryInstall}
            onArchiveInstalled={onStateChanged}
          />
        )}
      </div>
      <PluginManagerNotices
        catalogStatus={modern ? 'fresh' : catalogStatus}
        catalogMessage={catalogMessage}
        error={error}
        warning={warning}
      />

      <div className="grid min-h-0 flex-1 gap-3.5 overflow-hidden lg:grid-cols-[minmax(17rem,0.82fr)_minmax(0,1.5fr)]">
        <PluginBrowserPanel
          presentation={presentation}
          locale={locale}
          mobileDetailOpen={mobileDetailOpen}
          query={query}
          onQueryChange={(value) => {
            setQuery(value);
            setAvailableLimit(5);
            onSearchChange?.(value);
          }}
          scope={scope}
          onScopeChange={setScope}
          counts={counts}
          known={known}
          filtered={filtered}
          leadingGroups={leadingGroups}
          recommendedPlugins={recommendedPlugins}
          recommendationPool={recommendationPool}
          otherPlugins={otherPlugins}
          renderRows={renderRows}
          catalogCheck={catalogCheck}
          catalogStatus={catalogStatus}
          onCheckCatalog={onCheckCatalog}
          unavailable={!!unavailable}
          loading={loading}
          inventoryKnown={inventoryKnown}
          hasMore={hasMore}
          onMore={() => setAvailableLimit((limit) => limit + 5)}
          batchRunning={batch.phase === 'running'}
          onBatch={() => {
            setBatchFixtures(fixtures);
            setBatchEntries(attention.map((p) => pluginBatchEntry(p, unavailable)));
            batch.show();
            setMobileDetailOpen(true);
          }}
        />

        <div
          data-mobile-panel="detail"
          className={`${mobileDetailOpen ? 'flex' : 'hidden'} min-h-0 min-w-0 flex-col gap-2 lg:flex`}
        >
          <button
            type="button"
            onClick={() => {
              batch.close();
              setMobileDetailOpen(false);
            }}
            className="flex items-center gap-2 px-1 text-xs font-semibold text-cafe-secondary transition hover:text-cafe lg:hidden"
          >
            <HubIcon name="arrow-left" className="h-4 w-4" />
            返回插件列表
          </button>
          <div
            data-plugin-scroll-region="detail"
            className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1"
          >
            {batch.open ? (
              <PluginBatchPanel
                entries={batchEntries}
                controller={{
                  ...batch,
                  close: () => {
                    batch.close();
                    setMobileDetailOpen(false);
                  },
                }}
                onRetry={onCheckCatalog}
                onRepair={onRepair}
                onDetail={(id) => {
                  batch.close();
                  selection.select(id);
                  setMobileDetailOpen(true);
                  setConfigurationValidation((current) => ({ pluginId: id, request: current.request + 1 }));
                }}
              />
            ) : selected ? (
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
