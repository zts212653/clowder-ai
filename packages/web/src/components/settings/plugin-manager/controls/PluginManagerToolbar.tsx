'use client';

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { PluginArchiveInstallButton } from '../PluginArchiveInstallButton';
import { PluginDirectoryInstallButton } from '../PluginDirectoryInstallButton';
import { PluginMarketplaceSettings } from '../PluginMarketplaceSettings';
import { closePluginMenu, PluginManagerMenu } from './PluginManagerActions';
import { pluginManagerText } from './plugin-manager.shell-copy';

export function PluginManagerToolbar({
  onMarketplaceChange,
  onDirectoryInstall,
  onArchiveInstalled,
  locale,
  autoSynchronize = true,
}: {
  onMarketplaceChange?: (() => Promise<void>) | undefined;
  onDirectoryInstall?: ((path: string) => Promise<void>) | undefined;
  onArchiveInstalled?: (() => void | Promise<void>) | undefined;
  locale: string;
  autoSynchronize?: boolean;
}) {
  const t = pluginManagerText(locale);
  const [installTarget, setInstallTarget] = useState<HTMLDivElement | null>(null);
  const installEntry = (label: string, open: () => void, disabled = false) =>
    installTarget
      ? createPortal(
          <button
            type="button"
            className="console-button-ghost h-8 !font-medium"
            disabled={disabled}
            onKeyDown={(event) => {
              if (event.key === 'Escape') closePluginMenu(event.currentTarget);
            }}
            onBlur={(event) => {
              const menu = event.currentTarget.closest('details');
              if (menu && !menu.contains(event.relatedTarget)) menu.open = false;
            }}
            onClick={(event) => {
              open();
              closePluginMenu(event.currentTarget);
            }}
          >
            {label}
          </button>,
          installTarget,
        )
      : null;
  return (
    <div data-plugin-manager-toolbar className="flex flex-wrap items-start justify-end gap-2">
      <a
        href="/docs/plugin-development.md"
        target="_blank"
        rel="noopener noreferrer"
        className="pt-1.5 text-compact text-cafe-muted hover:text-cafe"
      >
        {t.docs}
      </a>
      {(onDirectoryInstall || onArchiveInstalled) && (
        <PluginManagerMenu label={t.installMenu} install contentRef={setInstallTarget}>
          {null}
        </PluginManagerMenu>
      )}
      {onDirectoryInstall && (
        <PluginDirectoryInstallButton
          onInstall={onDirectoryInstall}
          renderTrigger={(open) => installEntry(t.directory, open)}
        />
      )}
      {onArchiveInstalled && (
        <PluginArchiveInstallButton
          onInstalled={onArchiveInstalled}
          renderTrigger={(open, disabled) => installEntry(t.archive, open, disabled)}
        />
      )}
      <PluginMarketplaceSettings autoSynchronize={autoSynchronize} onChange={onMarketplaceChange} />
    </div>
  );
}
