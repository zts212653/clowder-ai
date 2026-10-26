import { PluginSourceLabel } from '../PluginSourceLabel';
import { PluginStatusDot } from '../PluginStatusDot';
import { PluginVisual } from '../PluginVisual';
import { pluginHasUpdate } from '../plugin-manager-attention';
import type { PluginManagerDesignFixture } from '../plugin-manager-fixtures';
import { PluginToggle } from './PluginManagerActions';
import { pluginManagerText } from './plugin-manager.shell-copy';

interface PluginDetailActionProps {
  plugin: PluginManagerDesignFixture;
  locale: string;
  busy: boolean;
  onSetEnabled?: ((enabled: boolean) => void) | undefined;
  onBlockedToggle?: (() => void) | undefined;
  onInstall?: (() => void) | undefined;
}

/** The selected detail remains actionable even when its list row is folded away. */
export function PluginDetailStateAction({
  plugin,
  locale,
  busy,
  onSetEnabled,
  onBlockedToggle,
  onInstall,
}: PluginDetailActionProps) {
  const t = pluginManagerText(locale);
  if (plugin.artifact === 'installed')
    return (
      <span className="flex items-center gap-2 text-compact text-cafe-secondary">
        <span>{plugin.intent === 'enabled' ? t.enabled : t.disabled}</span>
        <PluginToggle
          plugin={plugin}
          locale={locale}
          busy={busy}
          onSetEnabled={onSetEnabled}
          onBlockedToggle={onBlockedToggle}
        />
      </span>
    );
  if (!(plugin.actions?.install ?? plugin.artifact === 'absent') || !onInstall) return null;
  return (
    <button
      type="button"
      data-plugin-detail-action="install"
      disabled={busy}
      onClick={onInstall}
      className="console-button-primary !font-medium disabled:opacity-50"
    >
      {busy ? t.working : t.install}
    </button>
  );
}

export function PluginDetailHeader(props: PluginDetailActionProps) {
  const { plugin, locale } = props;
  const t = pluginManagerText(locale);
  const source =
    plugin.trust === 'unknown'
      ? t.unknownSource
      : plugin.trust === 'official'
        ? t.catalogSource
        : plugin.trust === 'first-party'
          ? t.builtinSource
          : t.localSource;
  return (
    <header
      data-plugin-detail-section="identity"
      className="flex flex-wrap items-center gap-3 border-b border-cafe-border pb-4"
    >
      <PluginVisual icon={plugin.icon} iconBg={plugin.iconBg} name={plugin.displayName} size="large" />
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-semibold text-cafe">{plugin.displayName}</h3>
        <p className="mt-1 break-words text-compact text-cafe-muted">
          {plugin.installedVersion ?? plugin.availableVersion} · {source}
        </p>
      </div>
      <PluginDetailStateAction {...props} />
    </header>
  );
}

export function PluginUpdateNotice({
  plugin,
  locale,
  busy,
  onInstall,
}: {
  plugin: PluginManagerDesignFixture;
  locale: string;
  busy: boolean;
  onInstall?: (() => void) | undefined;
}) {
  if (!pluginHasUpdate(plugin)) return null;
  const t = pluginManagerText(locale);
  return (
    <section
      data-plugin-detail-section="update"
      data-inline-notice
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-cafe-border bg-[var(--shell-work)] px-3 py-2.5"
    >
      <p className="flex items-center gap-2 text-sm text-cafe">
        <PluginStatusDot tone="update" className="h-2 w-2" />
        {t.newVersion(plugin.availableVersion)}
      </p>
      {onInstall && (
        <button
          type="button"
          data-plugin-detail-action="update"
          disabled={busy}
          onClick={onInstall}
          className="console-button-secondary !font-medium disabled:opacity-50"
        >
          {busy ? t.working : t.updateTo(plugin.availableVersion)}
        </button>
      )}
    </section>
  );
}

export function PluginDetailFooter({
  plugin,
  locale,
  busy,
  onUninstall,
}: {
  plugin: PluginManagerDesignFixture;
  locale: string;
  busy: boolean;
  onUninstall?: (() => void) | undefined;
}) {
  const t = pluginManagerText(locale);
  const canUninstall = plugin.actions?.uninstall ?? plugin.artifact === 'installed';
  return (
    <footer
      data-plugin-detail-section="provenance"
      className="flex flex-wrap items-center justify-between gap-3 border-t border-cafe-border pt-4"
    >
      <div className="min-w-0 space-y-1 break-all text-compact text-cafe-muted">
        <PluginSourceLabel trust={plugin.trust} repositoryName={plugin.repositoryName} locale={locale} />
        <p>
          {plugin.packageName} · {plugin.publisher} · {t.available(plugin.availableVersion)}
        </p>
      </div>
      {canUninstall && onUninstall && (
        <button
          type="button"
          data-plugin-uninstall
          disabled={busy}
          aria-label={
            plugin.artifact === 'quarantined' ? t.remove(plugin.displayName) : t.uninstall(plugin.displayName)
          }
          onClick={onUninstall}
          className="console-button-secondary shrink-0 !font-medium text-conn-red-text disabled:opacity-50"
        >
          {plugin.artifact === 'quarantined' ? t.removePlugin : t.uninstallPlugin}
        </button>
      )}
    </footer>
  );
}
