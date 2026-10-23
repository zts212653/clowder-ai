import { SettingsText } from '../primitives/SettingsText';
import { PluginUpdateNotice } from './controls/PluginManagerDetailChrome';
import { pluginManagerText } from './controls/plugin-manager.shell-copy';
import { pluginAttentionReason } from './plugin-manager-attention';
import type { PluginManagerDesignFixture } from './plugin-manager-fixtures';

/** Status and introduction precede the manifest-ordered configuration. */
export function PluginManagerDetailPrelude({
  plugin,
  description,
  locale = 'zh-CN',
  busy = false,
  onRepair,
  onInstall,
}: {
  plugin: PluginManagerDesignFixture;
  description: string;
  locale?: string;
  busy?: boolean;
  onRepair?: (() => void) | undefined;
  onInstall?: (() => void) | undefined;
}) {
  const reason = pluginAttentionReason(plugin, locale);
  const t = pluginManagerText(locale);
  return (
    <>
      {reason && (
        <section data-plugin-detail-section="attention" className="space-y-3">
          <div
            data-inline-notice
            className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2 rounded-lg border border-cafe-border bg-[var(--shell-work)] px-3 py-2.5"
          >
            <SettingsText as="p" variant="sm" tone="default">
              <span aria-hidden className="mr-2 inline-block h-2 w-2 rounded-full bg-conn-amber-text" />
              {reason}
            </SettingsText>
            {plugin.artifact === 'installed' && plugin.actions?.repair && onRepair && (
              <button
                type="button"
                data-plugin-detail-action="repair"
                disabled={busy}
                onClick={onRepair}
                className="console-button-primary col-start-2 row-start-1 !font-medium disabled:opacity-50"
              >
                {busy ? t.working : t.repair}
              </button>
            )}
            <SettingsText as="p" variant="sm" tone="secondary" className="col-span-2">
              {plugin.actions?.blockingReasons.includes('package-incompatible')
                ? t.incompatibleHint
                : plugin.artifact !== 'installed'
                  ? t.packageHint
                  : plugin.actions?.repair
                    ? t.repairHint
                    : t.configHint}
            </SettingsText>
            {plugin.diagnostic && (
              <details className="col-span-2 text-compact text-cafe-muted">
                <summary>{t.diagnostic}</summary>
                <p className="mt-1 break-words text-sm">{plugin.diagnostic}</p>
              </details>
            )}
          </div>
        </section>
      )}
      <PluginUpdateNotice plugin={plugin} locale={locale} busy={busy} onInstall={onInstall} />
      <section className="space-y-2" data-plugin-detail-section="introduction">
        <SettingsText as="h4" variant="xs" tone="muted" className="font-semibold">
          {t.introduction}
        </SettingsText>
        <SettingsText as="p" variant="sm" tone="secondary">
          {description}
        </SettingsText>
      </section>
      {!reason && plugin.diagnostic && (
        <details className="text-sm text-cafe-muted">
          <summary>{t.diagnosticHistory}</summary>
          <p className="mt-1">{plugin.diagnostic}</p>
        </details>
      )}
    </>
  );
}
