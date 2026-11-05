'use client';

import type { ReactNode } from 'react';
import { HubIcon } from '../../hub-icons';
import { settingsResourceCardClass } from '../../SettingsResourceCard';
import { SettingsText } from '../primitives/SettingsText';
import { pluginManagerText } from './controls/plugin-manager.shell-copy';
import { PluginCatalogCheck } from './PluginCatalogCheck';
import { PluginListSection } from './PluginManagerList';
import { type PluginScope, PluginScopeMenu } from './PluginScopeMenu';
import { installedPluginGroups, type PluginManagerPresentation, pluginHasUpdate } from './plugin-manager-attention';
import type { PluginManagerDesignFixture } from './plugin-manager-fixtures';
import type { PluginCatalogCheckState } from './usePluginCatalogCheck';

type Props = {
  presentation: PluginManagerPresentation;
  locale: string;
  mobileDetailOpen: boolean;
  query: string;
  onQueryChange: (query: string) => void;
  scope: PluginScope;
  onScopeChange: (scope: PluginScope) => void;
  counts: Record<PluginScope, number | null>;
  known: readonly PluginManagerDesignFixture[];
  filtered: readonly PluginManagerDesignFixture[];
  leadingGroups: ReturnType<typeof installedPluginGroups>;
  recommendedPlugins: readonly PluginManagerDesignFixture[];
  recommendationPool: readonly PluginManagerDesignFixture[];
  otherPlugins: readonly PluginManagerDesignFixture[];
  renderRows: (plugins: readonly PluginManagerDesignFixture[]) => ReactNode[];
  catalogCheck?: PluginCatalogCheckState;
  catalogStatus: string;
  onCheckCatalog?: () => void;
  unavailable: boolean;
  loading: boolean;
  inventoryKnown: boolean;
  hasMore: boolean;
  onMore: () => void;
  batchRunning: boolean;
  onBatch: () => void;
};

/** The catalogue browser stays mounted while the detail or batch panel changes. */
export function PluginBrowserPanel({
  presentation,
  locale,
  mobileDetailOpen,
  query,
  onQueryChange,
  scope,
  onScopeChange,
  counts,
  known,
  filtered,
  leadingGroups,
  recommendedPlugins,
  recommendationPool,
  otherPlugins,
  renderRows,
  catalogCheck,
  catalogStatus,
  onCheckCatalog,
  unavailable,
  loading,
  inventoryKnown,
  hasMore,
  onMore,
  batchRunning,
  onBatch,
}: Props) {
  const modern = presentation === 'v2';
  const t = pluginManagerText(locale);
  const catalogKnown = inventoryKnown && catalogStatus !== 'loading';
  const scopeCounts = {
    all: catalogKnown ? counts.all : null,
    attention: catalogKnown ? counts.attention : null,
    installed: inventoryKnown ? counts.installed : null,
    available: catalogKnown ? counts.available : null,
  };
  return (
    <div
      data-mobile-panel="list"
      className={`${mobileDetailOpen ? 'hidden' : 'flex'} min-h-0 min-w-0 flex-col gap-2 lg:flex`}
    >
      <div className="flex items-center gap-2">
        <label className={`${settingsResourceCardClass} flex flex-1 min-w-0 items-center gap-2 px-3 py-2.5`}>
          <HubIcon name="search" className="h-4 w-4 shrink-0 text-cafe-muted" />
          <input
            aria-label={modern ? '搜索全部插件' : t.search}
            value={query}
            onChange={(event) => {
              onQueryChange(event.target.value);
            }}
            placeholder={modern ? '搜索全部插件' : t.search}
            className="min-w-0 flex-1 bg-transparent text-sm text-cafe outline-none placeholder:text-cafe-muted"
          />
        </label>
        {modern && <PluginScopeMenu value={scope} counts={scopeCounts} onChange={onScopeChange} />}
      </div>
      {modern && (
        <PluginCatalogCheck
          state={catalogCheck}
          status={catalogStatus}
          updates={known.filter(pluginHasUpdate).length}
          onCheck={onCheckCatalog}
          hasCachedEntries={known.some((p) => p.artifact === 'absent')}
        />
      )}
      {/* Keep absolute accessibility labels inside this scroll container's containing block. */}
      <div
        data-plugin-scroll-region="list"
        className="relative min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain pr-1"
        onScroll={(event) => {
          const list = event.currentTarget;
          if (hasMore && list.scrollHeight - list.scrollTop - list.clientHeight < 96) onMore();
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
              {modern && !inventoryKnown
                ? '插件列表读不到，暂时无法显示插件'
                : modern && scope === 'available' && !query.trim()
                  ? catalogStatus === 'loading'
                    ? '正在读取插件目录…'
                    : unavailable
                      ? '插件目录读不到，暂时看不到可以安装的插件'
                      : '插件目录里的插件都装好了'
                  : '没有符合条件的插件'}
              {modern && scope === 'available' && unavailable && (
                <button type="button" onClick={onCheckCatalog} className="mt-2 block w-full text-xs text-cafe-accent">
                  再试一次
                </button>
              )}
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
                action={
                  modern &&
                  kind === 'attention' && (
                    <button
                      type="button"
                      className="console-button-secondary !h-7 !px-2 text-xs"
                      disabled={batchRunning}
                      onClick={onBatch}
                    >
                      一起处理…
                    </button>
                  )
                }
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
              <button type="button" onClick={() => onMore()} className="console-inline-link w-full py-2 text-sm">
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
  );
}
