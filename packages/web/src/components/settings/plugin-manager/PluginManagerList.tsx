'use client';

import { resolvePluginDescription } from '@cat-cafe/shared';
import type { ReactNode } from 'react';
import { settingsResourceCardClass } from '../../SettingsResourceCard';
import { SettingsText } from '../primitives/SettingsText';
import { PluginRowActions } from './controls/PluginManagerActions';
import { pluginManagerText } from './controls/plugin-manager.shell-copy';
import { PluginSourceLabel } from './PluginSourceLabel';
import { PluginStatusDot } from './PluginStatusDot';
import { PluginVisual } from './PluginVisual';
import {
  type PluginManagerPresentation,
  pluginAttentionReason,
  pluginAttentionTone,
  pluginHasUpdate,
} from './plugin-manager-attention';
import type { PluginManagerDesignFixture } from './plugin-manager-fixtures';

export function PluginListSection({
  kind,
  title,
  ariaLabel,
  rows,
  count,
}: {
  kind: 'installed' | 'attention' | 'recommended' | 'other' | 'available';
  title: string;
  ariaLabel: string;
  rows: readonly ReactNode[];
  count?: number;
}) {
  if (rows.length === 0) return null;
  return (
    <section data-plugin-section={kind} className="space-y-2">
      <SettingsText as="h3" variant="xs" tone="muted" className="px-1 font-semibold">
        {title}
        {count === undefined ? '' : ` · ${count}`}
      </SettingsText>
      <ul
        aria-label={ariaLabel}
        className={
          count === undefined
            ? 'space-y-2'
            : 'overflow-hidden rounded-xl border border-cafe-border bg-[var(--console-card-bg)] divide-y divide-cafe-border'
        }
      >
        {rows}
      </ul>
    </section>
  );
}

export function PluginListRow({
  plugin,
  selected,
  onSelect,
  onInstall,
  onSetEnabled,
  onRepair,
  onBlockedToggle,
  onUninstall,
  busy,
  enableBlockedReason,
  locale,
  presentation = 'v1',
}: {
  plugin: PluginManagerDesignFixture;
  selected: boolean;
  onSelect: () => void;
  onInstall?: () => void;
  onSetEnabled?: (enabled: boolean) => void;
  onRepair?: () => void;
  onBlockedToggle?: () => void;
  onUninstall?: () => void;
  busy: boolean;
  enableBlockedReason?: string;
  locale: string;
  presentation?: PluginManagerPresentation;
}) {
  const installed = plugin.artifact === 'installed';
  const canInstall = plugin.actions?.install ?? !installed;
  const description = resolvePluginDescription(plugin.description, locale);
  const reason = presentation === 'v2' ? pluginAttentionReason(plugin, locale) : undefined;
  const t = pluginManagerText(locale);
  const summary = reason ?? (pluginHasUpdate(plugin) ? t.newVersion(plugin.availableVersion) : description);
  const modern = presentation === 'v2';
  return (
    <li
      data-plugin-id={plugin.id}
      data-plugin-list-row="true"
      aria-current={selected ? 'true' : undefined}
      className={`${modern ? '' : `${settingsResourceCardClass} min-h-[88px]`} group/plugin-row [container-type:inline-size] transition-colors ${
        selected ? '' : 'hover:bg-[var(--console-hover-bg)]'
      }`}
      style={selected ? { backgroundColor: modern ? 'var(--shell-selected)' : 'var(--console-active-bg)' } : undefined}
    >
      <div
        className={
          modern
            ? 'relative flex min-h-[62px] w-full items-center gap-3 px-3.5 py-2 [@container(max-width:23rem)]:min-h-[80px]'
            : 'grid min-h-[88px] w-full grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-2 px-4 py-3 [@container(max-width:23rem)]:grid-cols-[minmax(0,1fr)_auto]'
        }
      >
        <button
          type="button"
          className={`flex min-w-0 items-center gap-3 text-left ${modern ? 'flex-1 [@container(max-width:23rem)]:pr-10' : ''}`}
          onClick={onSelect}
        >
          <PluginVisual
            icon={plugin.icon}
            iconBg={plugin.iconBg}
            name={plugin.displayName}
            className={modern ? '!h-[34px] !w-[34px] !rounded-[9px]' : ''}
          />
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1.5">
              <SettingsText
                as="span"
                variant="sm"
                tone="default"
                title={plugin.displayName}
                className="block truncate font-medium"
              >
                {plugin.displayName}
              </SettingsText>
              {modern && (plugin.trust === 'unknown' || plugin.trust === 'unverified') && (
                <span
                  data-plugin-source-trust={plugin.trust}
                  title={t.source[plugin.trust]}
                  className="max-w-[45%] shrink-0 truncate rounded border border-cafe-border px-1 text-micro font-normal text-cafe-muted"
                >
                  {t.unknownSource}
                </span>
              )}
            </span>
            {!modern && (
              <PluginSourceLabel
                trust={plugin.trust}
                repositoryName={plugin.repositoryName}
                compact
                locale={locale}
                availableVersion={installed && canInstall ? plugin.availableVersion : undefined}
              />
            )}
            {modern && (
              <span
                data-plugin-summary
                data-plugin-attention={reason ? '' : undefined}
                className="mt-0.5 flex min-w-0 items-center gap-1.5 text-compact text-cafe-secondary [@container(max-width:23rem)]:pr-8"
              >
                {(reason || pluginHasUpdate(plugin)) && (
                  <PluginStatusDot tone={reason ? pluginAttentionTone(plugin) : 'update'} />
                )}
                <span
                  className={
                    reason
                      ? 'min-w-0 truncate [@container(max-width:23rem)]:whitespace-normal [@container(max-width:23rem)]:overflow-visible [@container(max-width:23rem)]:text-clip'
                      : 'truncate'
                  }
                  title={plugin.diagnostic && reason ? plugin.diagnostic : summary}
                >
                  {summary}
                </span>
              </span>
            )}
            {presentation === 'v1' && (
              <span
                data-plugin-description="true"
                className="mt-0.5 block line-clamp-2 text-compact text-cafe-secondary"
              >
                {description}
              </span>
            )}
            {!modern && reason && (
              <span data-plugin-attention className="mt-1 flex items-center gap-1.5 text-compact text-cafe-secondary">
                <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-conn-amber-text" />
                <span className="truncate" title={plugin.diagnostic ?? reason}>
                  {reason}
                </span>
              </span>
            )}
          </span>
        </button>
        <PluginRowActions
          plugin={plugin}
          locale={locale}
          busy={busy}
          onInstall={onInstall}
          onRepair={onRepair}
          onSetEnabled={onSetEnabled}
          onBlockedToggle={onBlockedToggle}
          onUninstall={onUninstall}
          allowOverflow={!modern}
        />
      </div>
      {enableBlockedReason && (
        <output className="block px-4 pb-3 text-xs text-conn-amber-text">{enableBlockedReason}</output>
      )}
    </li>
  );
}
