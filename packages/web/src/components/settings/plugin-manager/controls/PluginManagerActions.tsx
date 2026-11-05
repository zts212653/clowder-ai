'use client';

import type { ReactNode, Ref } from 'react';
import type { PluginManagerDesignFixture } from '../plugin-manager-fixtures';
import { pluginManagerText } from './plugin-manager.shell-copy';

export function PluginManagerMenu({
  label,
  children,
  busy = false,
  install = false,
  contentRef,
}: {
  label: string;
  children: ReactNode;
  busy?: boolean;
  install?: boolean;
  contentRef?: Ref<HTMLDivElement>;
}) {
  return (
    <details
      className="relative shrink-0"
      data-plugin-action-menu
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.currentTarget.open = false;
          event.currentTarget.querySelector('summary')?.focus();
        }
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
      }}
    >
      <summary
        role="button"
        aria-label={label}
        aria-disabled={busy}
        onClick={(event) => {
          if (busy) event.preventDefault();
        }}
        className={`${install ? 'console-button-secondary !font-medium' : 'flex h-8 w-8 items-center justify-center rounded-lg text-cafe-muted hover:bg-[var(--console-hover-bg)]'} cursor-pointer list-none [&::-webkit-details-marker]:hidden`}
      >
        {install ? `${label} ⌄` : '⋯'}
      </summary>
      <div
        ref={contentRef}
        className="absolute right-0 top-full z-30 mt-1 min-w-40 rounded-lg border border-cafe-border bg-[var(--console-card-bg)] p-1 shadow-lg [&_button]:w-full [&_button]:justify-start"
      >
        {children}
      </div>
    </details>
  );
}

export function closePluginMenu(target: Element) {
  const menu = target.closest('details');
  if (menu) {
    menu.open = false;
    menu.querySelector('summary')?.focus();
  }
}

export function pluginMainAction(
  plugin: PluginManagerDesignFixture,
  locale: string,
  onInstall?: () => void,
  onRepair?: () => void,
) {
  const t = pluginManagerText(locale);
  const installed = plugin.artifact === 'installed';
  if (installed && plugin.actions?.repair && onRepair) return { kind: 'repair', label: t.repair, onClick: onRepair };
  if ((plugin.actions?.install ?? !installed) && onInstall)
    return { kind: installed ? 'update' : 'install', label: installed ? t.update : t.install, onClick: onInstall };
  return undefined;
}

export function PluginToggle({
  plugin,
  locale,
  busy,
  onSetEnabled,
  onBlockedToggle,
  className = '',
}: {
  plugin: PluginManagerDesignFixture;
  locale: string;
  busy: boolean;
  onSetEnabled?: ((enabled: boolean) => void) | undefined;
  onBlockedToggle?: (() => void) | undefined;
  className?: string;
}) {
  if (plugin.artifact !== 'installed') return null;
  const t = pluginManagerText(locale);
  const subject = plugin.id === 'official.chatgpt-dot' && !locale.startsWith('en') ? 'dot协作' : plugin.displayName;
  return (
    <button
      type="button"
      data-enabled={plugin.intent === 'enabled'}
      disabled={busy}
      aria-label={plugin.intent === 'enabled' ? t.disable(subject) : t.enable(subject)}
      aria-pressed={plugin.intent === 'enabled'}
      onClick={(event) => {
        event.stopPropagation();
        if (plugin.actions?.setEnabled ?? true) onSetEnabled?.(plugin.intent !== 'enabled');
        else onBlockedToggle?.();
      }}
      className={`relative h-4 w-[26px] shrink-0 rounded-full disabled:opacity-50 ${plugin.intent === 'enabled' ? 'bg-[var(--cafe-text)]' : 'border border-[var(--cafe-text-muted)] bg-[var(--console-card-bg)]'} ${className}`}
    >
      <span
        aria-hidden="true"
        className={`absolute top-0.5 h-3 w-3 rounded-full ${plugin.intent === 'enabled' ? 'left-3 bg-[var(--console-card-bg)]' : 'left-0.5 bg-[var(--cafe-text-muted)]'}`}
      />
    </button>
  );
}

export function PluginRowActions({
  plugin,
  onConfigure,
  locale,
  busy,
  locked = false,
  onInstall,
  onRepair,
  onSetEnabled,
  onBlockedToggle,
  onUninstall,
  allowOverflow = true,
}: {
  plugin: PluginManagerDesignFixture;
  onConfigure?: () => void;
  locale: string;
  busy: boolean;
  locked?: boolean;
  onInstall?: (() => void) | undefined;
  onRepair?: (() => void) | undefined;
  onSetEnabled?: ((enabled: boolean) => void) | undefined;
  onBlockedToggle?: (() => void) | undefined;
  onUninstall?: (() => void) | undefined;
  allowOverflow?: boolean;
}) {
  const t = pluginManagerText(locale);
  const disabled = busy || locked;
  const installed = plugin.artifact === 'installed';
  const action =
    installed && plugin.config !== 'ready' && onConfigure
      ? { kind: 'configure', label: locale.startsWith('en') ? 'Configure' : '去填写', onClick: onConfigure }
      : pluginMainAction(plugin, locale, onInstall, onRepair);
  const canUninstall = plugin.actions?.uninstall ?? installed;
  const secondaryUpdate = action?.kind === 'repair' && plugin.actions?.install && onInstall;
  const subject = plugin.id === 'official.chatgpt-dot' && !locale.startsWith('en') ? 'dot协作' : plugin.displayName;
  return (
    <>
      {action && (
        <button
          type="button"
          data-plugin-primary-action={action.kind}
          disabled={disabled}
          onClick={action.onClick}
          className={`console-button-secondary h-8 shrink-0 !font-medium ${
            allowOverflow
              ? '[@container(max-width:23rem)]:col-start-1 [@container(max-width:23rem)]:row-start-2 [@container(max-width:23rem)]:justify-self-end'
              : '[@container(max-width:23rem)]:absolute [@container(max-width:23rem)]:bottom-2 [@container(max-width:23rem)]:right-3.5'
          }`}
        >
          {busy ? t.working : action.label}
        </button>
      )}
      <PluginToggle
        plugin={plugin}
        locale={locale}
        busy={disabled}
        onSetEnabled={onSetEnabled}
        onBlockedToggle={onBlockedToggle}
        className={
          allowOverflow
            ? '[@container(max-width:23rem)]:col-start-2 [@container(max-width:23rem)]:row-start-1'
            : '[@container(max-width:23rem)]:absolute [@container(max-width:23rem)]:right-3.5 [@container(max-width:23rem)]:top-3'
        }
      />
      {allowOverflow && (canUninstall || secondaryUpdate) && (
        <span className="shrink-0 [@container(max-width:23rem)]:col-start-2 [@container(max-width:23rem)]:row-start-2">
          <PluginManagerMenu label={t.more(subject)} busy={disabled}>
            {secondaryUpdate && (
              <button
                type="button"
                className="console-button-ghost h-8 !font-medium"
                disabled={disabled}
                onClick={(event) => {
                  closePluginMenu(event.currentTarget);
                  onInstall?.();
                }}
              >
                {t.update}
              </button>
            )}
            {canUninstall && (
              <button
                type="button"
                data-plugin-uninstall
                className="console-button-ghost h-8 !font-medium"
                disabled={disabled}
                aria-label={plugin.artifact === 'quarantined' ? t.remove(subject) : t.uninstall(subject)}
                onClick={(event) => {
                  closePluginMenu(event.currentTarget);
                  onUninstall?.();
                }}
              >
                {plugin.artifact === 'quarantined' ? t.remove(subject) : t.uninstall(subject)}
              </button>
            )}
          </PluginManagerMenu>
        </span>
      )}
    </>
  );
}
