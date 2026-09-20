'use client';

import { resolvePluginDescription } from '@cat-cafe/shared';
import type { ReactNode } from 'react';
import {
  SettingsResourceToggleSwitch,
  settingsResourceActionGroupClass,
  settingsResourceCardClass,
  settingsResourceRowClass,
} from '../../SettingsResourceCard';
import { SettingsDeleteButton } from '../primitives/SettingsDeleteButton';
import { SettingsPrimaryButton } from '../primitives/SettingsPrimaryButton';
import { SettingsText } from '../primitives/SettingsText';
import { PluginVisual } from './PluginVisual';
import type { PluginManagerDesignFixture } from './plugin-manager-fixtures';

export function PluginListSection({
  kind,
  title,
  ariaLabel,
  rows,
}: {
  kind: 'installed' | 'attention' | 'recommended' | 'other';
  title: string;
  ariaLabel: string;
  rows: readonly ReactNode[];
}) {
  if (rows.length === 0) return null;
  return (
    <section data-plugin-section={kind} className="space-y-2">
      <SettingsText as="h3" variant="xs" tone="muted" className="px-1 font-semibold">
        {title}
      </SettingsText>
      <ul aria-label={ariaLabel} className="space-y-2">
        {rows}
      </ul>
    </section>
  );
}

function PluginListActions({
  plugin,
  installed,
  canInstall,
  canSetEnabled,
  showLifecycleToggle,
  canUninstall,
  busy,
  onInstall,
  onSetEnabled,
  onBlockedToggle,
  onUninstall,
}: {
  plugin: PluginManagerDesignFixture;
  installed: boolean;
  canInstall: boolean;
  canSetEnabled: boolean;
  showLifecycleToggle: boolean;
  canUninstall: boolean;
  busy: boolean;
  onInstall: (() => void) | undefined;
  onSetEnabled: ((enabled: boolean) => void) | undefined;
  onBlockedToggle: (() => void) | undefined;
  onUninstall: (() => void) | undefined;
}) {
  if (canInstall) {
    return (
      <SettingsPrimaryButton onClick={() => onInstall?.()} disabled={busy}>
        安装
      </SettingsPrimaryButton>
    );
  }
  if (!installed && !canUninstall) return null;
  return (
    <>
      {installed && showLifecycleToggle && (
        <SettingsResourceToggleSwitch
          enabled={plugin.intent === 'enabled'}
          busy={busy}
          onClick={(event) => {
            event.stopPropagation();
            if (canSetEnabled) {
              onSetEnabled?.(plugin.intent !== 'enabled');
              return;
            }
            onBlockedToggle?.();
          }}
          ariaLabel={`${plugin.intent === 'enabled' ? '禁用' : '启用'}${plugin.displayName}`}
          ariaPressed={plugin.intent === 'enabled'}
        />
      )}
      {canUninstall && (
        <SettingsDeleteButton
          onClick={() => onUninstall?.()}
          disabled={busy}
          aria-label={`${plugin.artifact === 'quarantined' ? '移除' : '卸载'}${plugin.displayName}`}
        />
      )}
    </>
  );
}

export function PluginListRow({
  plugin,
  selected,
  onSelect,
  onInstall,
  onSetEnabled,
  onBlockedToggle,
  onUninstall,
  busy,
  locale,
}: {
  plugin: PluginManagerDesignFixture;
  selected: boolean;
  onSelect: () => void;
  onInstall?: () => void;
  onSetEnabled?: (enabled: boolean) => void;
  onBlockedToggle?: () => void;
  onUninstall?: () => void;
  busy: boolean;
  locale: string;
}) {
  const installed = plugin.artifact === 'installed';
  const canInstall = plugin.actions?.install ?? !installed;
  const canSetEnabled = plugin.actions?.setEnabled ?? installed;
  const canUninstall = plugin.actions?.uninstall ?? installed;
  const showLifecycleToggle = installed && plugin.sourceAdapter === undefined;
  const description = resolvePluginDescription(plugin.description, locale);
  return (
    <li
      data-plugin-id={plugin.id}
      data-plugin-list-row="true"
      aria-current={selected ? 'true' : undefined}
      className={`${settingsResourceCardClass} min-h-[88px] transition-colors ${
        selected ? '' : 'hover:bg-[var(--console-hover-bg)]'
      }`}
      style={selected ? { backgroundColor: 'var(--console-active-bg)' } : undefined}
    >
      <div className={`${settingsResourceRowClass} min-h-[88px] w-full`}>
        <button type="button" className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={onSelect}>
          <PluginVisual icon={plugin.icon} iconBg={plugin.iconBg} name={plugin.displayName} />
          <span className="min-w-0 flex-1">
            <SettingsText as="span" variant="sm" tone="default" className="block truncate font-semibold">
              {plugin.displayName}
            </SettingsText>
            <span data-plugin-description="true" className="mt-0.5 line-clamp-2 block overflow-hidden">
              <SettingsText as="span" variant="xs" tone="secondary">
                {description}
              </SettingsText>
            </span>
          </span>
        </button>
        <div className={settingsResourceActionGroupClass}>
          <PluginListActions
            plugin={plugin}
            installed={installed}
            canInstall={canInstall}
            canSetEnabled={canSetEnabled}
            showLifecycleToggle={showLifecycleToggle}
            canUninstall={canUninstall}
            busy={busy}
            onInstall={onInstall}
            onSetEnabled={onSetEnabled}
            onBlockedToggle={onBlockedToggle}
            onUninstall={onUninstall}
          />
        </div>
      </div>
    </li>
  );
}
