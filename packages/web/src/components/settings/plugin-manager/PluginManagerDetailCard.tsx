'use client';

import { resolvePluginDescription } from '@cat-cafe/shared';
import { personalChromeSettingsHref } from '@/utils/personal-chrome-settings';
import { HubIcon } from '../../hub-icons';
import { settingsResourceCardClass, settingsResourceRowClass } from '../../SettingsResourceCard';
import { SettingsText } from '../primitives/SettingsText';
import { PluginDetailFooter, PluginDetailHeader, PluginDetailStateAction } from './controls/PluginManagerDetailChrome';
import { pluginManagerText } from './controls/plugin-manager.shell-copy';
import { DotConnectionDetail } from './DotConnectionDetail';
import { PluginCapabilityDocumentation } from './PluginCapabilityDocumentation';
import PluginConnectorSettings from './PluginConnectorSettings';
import { PluginManagerBindings } from './PluginManagerBindings';
import { PluginManagerConfigurationSection } from './PluginManagerConfigurationSection';
import { PluginManagerDetailPrelude } from './PluginManagerDetailPrelude';
import { PluginSourceLabel } from './PluginSourceLabel';
import { PluginVisual } from './PluginVisual';
import type { PluginManagerPresentation } from './plugin-manager-attention';
import type { PluginManagerDesignFixture } from './plugin-manager-fixtures';

function SectionHeading({ children }: { children: string }) {
  return (
    <SettingsText as="h4" variant="xs" tone="muted" className="font-semibold">
      {children}
    </SettingsText>
  );
}

function dependencyClosureLabel(plugin: PluginManagerDesignFixture): string | undefined {
  if (plugin.dependencyClosure === 'shipped') return '本机自带依赖 · 仅限本机开发';
  if (plugin.dependencyClosure === 'materialized') return '安装时解析依赖';
  return undefined;
}

export function PluginManagerDetailCard({
  plugin,
  locale,
  presentation = 'v1',
  onOperationChange,
  busy = false,
  onSaveConfig,
  configurationValidationRequest = 0,
  configurationSaved = false,
  onStateChanged,
  onInstall,
  onRepair,
  onUninstall,
  onSetEnabled,
  onBlockedToggle,
}: {
  plugin: PluginManagerDesignFixture;
  locale: string;
  presentation?: PluginManagerPresentation;
  onOperationChange?: () => void;
  busy?: boolean;
  onSaveConfig?: (updates: readonly { key: string; value: string | null }[]) => void;
  configurationValidationRequest?: number;
  configurationSaved?: boolean;
  onStateChanged?: () => void | Promise<void>;
  onInstall?: (() => void) | undefined;
  onRepair?: (() => void) | undefined;
  onUninstall?: (() => void) | undefined;
  onSetEnabled?: ((enabled: boolean) => void) | undefined;
  onBlockedToggle?: (() => void) | undefined;
}) {
  const installed = plugin.artifact === 'installed';
  const description = resolvePluginDescription(plugin.description, locale);
  const closureLabel = dependencyClosureLabel(plugin);
  const t = pluginManagerText(locale);

  return (
    <article data-testid="plugin-manager-detail" className={settingsResourceCardClass}>
      <div className="max-w-[720px] space-y-5 p-4 text-sm [&_label]:text-sm">
        {presentation === 'v2' && (
          <PluginDetailHeader
            plugin={plugin}
            locale={locale}
            busy={busy}
            onInstall={onInstall}
            onSetEnabled={onSetEnabled}
            onBlockedToggle={onBlockedToggle}
          />
        )}
        {presentation === 'v1' && (
          <section className="space-y-2.5" data-plugin-detail-section="identity">
            <SectionHeading>{t.identity}</SectionHeading>
            <div className={`${settingsResourceRowClass} w-full flex-wrap px-0 py-0`}>
              <PluginVisual icon={plugin.icon} iconBg={plugin.iconBg} name={plugin.displayName} size="large" />
              <div className="min-w-0 flex-1">
                <SettingsText as="h3" variant="sm" tone="default" className="font-semibold">
                  {plugin.displayName}
                </SettingsText>
                <PluginSourceLabel trust={plugin.trust} repositoryName={plugin.repositoryName} locale={locale} />
                <SettingsText as="p" variant="xs" tone="muted" className="mt-0.5 break-all !text-compact">
                  {plugin.installedVersion ?? plugin.availableVersion} · {plugin.packageName} · {plugin.publisher}
                </SettingsText>
                {plugin.installedVersion && plugin.availableVersion !== plugin.installedVersion && (
                  <SettingsText as="p" variant="xs" tone="secondary" className="break-all !text-compact">
                    {t.available(plugin.availableVersion)}
                  </SettingsText>
                )}
                {closureLabel === undefined ? null : (
                  <SettingsText as="p" variant="xs" tone="muted" className="mt-0.5">
                    {closureLabel}
                  </SettingsText>
                )}
              </div>
              <PluginDetailStateAction
                plugin={plugin}
                locale={locale}
                busy={busy}
                onInstall={onInstall}
                onSetEnabled={onSetEnabled}
                onBlockedToggle={onBlockedToggle}
              />
            </div>
          </section>
        )}

        {presentation === 'v1' && (
          <section className="space-y-2" data-plugin-detail-section="introduction">
            <SectionHeading>插件简介</SectionHeading>
            <SettingsText as="p" variant="sm" tone="secondary">
              {description}
            </SettingsText>
          </section>
        )}

        {presentation === 'v1' && plugin.diagnostic && (
          <div className="flex items-start gap-2 rounded-xl bg-conn-amber-bg px-3 py-2.5">
            <HubIcon name="alert-triangle" className="mt-0.5 h-4 w-4 shrink-0 text-conn-amber-text" />
            <SettingsText as="p" variant="sm" tone="amber">
              {plugin.diagnostic}
            </SettingsText>
          </div>
        )}

        {plugin.id === 'official.chatgpt-dot' ? (
          <>
            <section className="space-y-2">
              <SectionHeading>ChatGPT Pro · 本机 Chrome</SectionHeading>
              <SettingsText as="p" variant="sm" tone="secondary">
                要让砚砚 Pro 接收消息，请安装并启用 Personal Chrome，准备 Chrome
                连接，再在扩展中授权指定会话。回到当前对话选择并连接该会话后，才能向它发送消息。
              </SettingsText>
              <a
                href={personalChromeSettingsHref()}
                className="inline-block text-sm font-medium text-cafe-interactive hover:underline"
              >
                设置 Personal Chrome
              </a>
            </section>
            {presentation === 'v2' && (
              <PluginManagerDetailPrelude
                plugin={plugin}
                description={description}
                locale={locale}
                busy={busy}
                onInstall={onInstall}
                onRepair={onRepair}
              />
            )}
            <DotConnectionDetail
              installed={installed}
              compact={presentation === 'v2'}
              activationRequest={configurationValidationRequest}
              activationAllowed={plugin.intent === 'enabled' || plugin.actions?.setEnabled === true}
              onStateChanged={onStateChanged}
              secondaryAction
            />
          </>
        ) : (
          <>
            <PluginManagerConfigurationSection
              plugin={plugin}
              presentation={presentation}
              beforeConfiguration={
                presentation === 'v2' ? (
                  <PluginManagerDetailPrelude
                    plugin={plugin}
                    description={description}
                    locale={locale}
                    busy={busy}
                    onInstall={onInstall}
                    onRepair={onRepair}
                  />
                ) : undefined
              }
              onOperationChange={onOperationChange}
              busy={busy}
              onSaveConfig={onSaveConfig}
              validationRequest={configurationValidationRequest}
              saved={configurationSaved}
            />

            {installed && plugin.permissions && (
              <PluginConnectorSettings key={plugin.id} pluginId={plugin.id} pluginLabel={plugin.permissions.label} />
            )}

            {plugin.bindings !== undefined && (
              <PluginManagerBindings
                key={plugin.id}
                pluginId={plugin.id}
                bindings={plugin.bindings}
                onChange={onOperationChange}
              />
            )}

            <PluginCapabilityDocumentation plugin={plugin} presentation={presentation} />
          </>
        )}
        {presentation === 'v2' && (
          <PluginDetailFooter plugin={plugin} locale={locale} busy={busy} onUninstall={onUninstall} />
        )}
      </div>
    </article>
  );
}
