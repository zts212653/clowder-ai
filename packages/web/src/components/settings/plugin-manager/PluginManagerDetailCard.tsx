'use client';

import { resolvePluginDescription } from '@cat-cafe/shared';
import { ExternalLinkIcon } from '../../HubConfigIcons';
import { HubIcon } from '../../hub-icons';
import { MarkdownContent } from '../../MarkdownContent';
import { settingsResourceCardClass, settingsResourceRowClass } from '../../SettingsResourceCard';
import { SettingsText } from '../primitives/SettingsText';
import { PluginManagerBindings } from './PluginManagerBindings';
import { PluginManagerConfigurationSection } from './PluginManagerConfigurationSection';
import { PluginManagerDetailPrelude } from './PluginManagerDetailPrelude';
import { PluginVisual } from './PluginVisual';
import type { PluginManagerPresentation } from './plugin-manager-attention';
import { pluginCapabilityKind, pluginCapabilityName } from './plugin-manager-copy';
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

const contributionKindLabel: Record<string, string> = {
  mcp: 'MCP',
  schedule: 'Scheduler',
  skill: 'Skill',
  'direct-tool': 'Tool',
  limb: 'Limb',
  webhook: 'Webhook',
  messaging: 'Messaging',
  events: 'Events',
  identity: 'Identity',
  connector: 'Connector',
  service: 'Service',
  ui: 'UI',
  'content-editor-provider': 'Content Editor',
  'desktop-window': 'Desktop Window',
};

interface CapabilityDocItem {
  key: string;
  kind: string;
  name: string;
  identifier: string;
  description?: string;
  originalName?: string;
}

function CapabilityDocRow({ item }: { item: CapabilityDocItem }) {
  return (
    <li className="list-disc">
      <SettingsText as="p" variant="sm" tone="secondary">
        <span className="font-medium text-cafe">{item.name}</span>
        {item.originalName && (
          <code className="ml-1 break-all font-mono text-xs text-cafe-muted">{item.originalName}</code>
        )}
        {item.description === undefined ? null : <span> — {item.description}</span>}
      </SettingsText>
    </li>
  );
}

function capabilityDocItems(
  plugin: PluginManagerDesignFixture,
  presentation: PluginManagerPresentation,
): CapabilityDocItem[] {
  const items: CapabilityDocItem[] = (plugin.contributions ?? []).flatMap((contribution) => {
    const tools =
      contribution.kind === 'mcp' ? (plugin.tools ?? []).filter((tool) => tool.contributionId === contribution.id) : [];
    if (tools.length > 0) {
      return tools.map((tool) => ({
        key: `${contribution.id}:${tool.name}`,
        kind: 'mcp',
        name: tool.name,
        identifier: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
      }));
    }
    return [
      {
        key: contribution.id,
        kind: contribution.kind,
        name: contribution.name,
        identifier: contribution.id,
        ...(contribution.description === undefined ? {} : { description: contribution.description }),
      },
    ];
  });
  return presentation === 'v1'
    ? items
    : items.map((item) => {
        const name = pluginCapabilityName(plugin.id, item.name);
        const originalName = name === item.name ? item.identifier : item.name;
        return { ...item, name, ...(originalName === name ? {} : { originalName }) };
      });
}

function groupCapabilityDocs(items: readonly CapabilityDocItem[]) {
  const groups = new Map<string, CapabilityDocItem[]>();
  for (const item of items) {
    const group = groups.get(item.kind) ?? [];
    group.push(item);
    groups.set(item.kind, group);
  }
  return [...groups].map(([kind, groupedItems]) => ({ kind, items: groupedItems }));
}

function CapabilityDocumentation({
  plugin,
  installed,
  groups,
  presentation,
}: {
  plugin: PluginManagerDesignFixture;
  installed: boolean;
  groups: readonly { kind: string; items: CapabilityDocItem[] }[];
  presentation: PluginManagerPresentation;
}) {
  return (
    <section className="space-y-3" data-plugin-detail-section="capability-docs">
      <SectionHeading>{presentation === 'v2' ? '能力' : '能力说明'}</SectionHeading>
      {plugin.readme.state === 'loading' ? (
        <SettingsText as="p" variant="sm" tone="muted">
          README 加载中…
        </SettingsText>
      ) : plugin.readme.state === 'unavailable' ? (
        <SettingsText as="p" variant="sm" tone="muted">
          README 暂不可用。
        </SettingsText>
      ) : plugin.readme.state === 'absent' ? null : (
        <MarkdownContent content={plugin.readme.markdown} disableCommandPrefix />
      )}
      {plugin.docsUrl && (
        <a href={plugin.docsUrl} target="_blank" rel="noopener noreferrer" className="console-inline-link">
          <ExternalLinkIcon />
          <span>查看插件文档</span>
        </a>
      )}
      {plugin.contributions === undefined ? (
        <SettingsText as="p" variant="sm" tone="muted">
          {installed ? '能力信息暂不可用。' : '安装后可查看具体工具与用途。'}
        </SettingsText>
      ) : groups.length > 0 ? (
        <div className="space-y-3">
          {groups.map(({ kind, items }) => (
            <section key={kind} className="space-y-1.5" data-contribution-kind={kind}>
              <SettingsText as="h5" variant="xs" tone="muted" className="font-semibold">
                {presentation === 'v2' ? pluginCapabilityKind(kind) : (contributionKindLabel[kind] ?? kind)}
              </SettingsText>
              {kind === 'mcp' && plugin.live === 'running' && plugin.tools === undefined && (
                <SettingsText as="p" variant="xs" tone="muted">
                  工具信息暂不可用。
                </SettingsText>
              )}
              <ul className="space-y-1.5 pl-4">
                {items.map((item) => (
                  <CapabilityDocRow key={item.key} item={item} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : (
        <SettingsText as="p" variant="sm" tone="muted">
          此插件未声明可展示的工具或资源。
        </SettingsText>
      )}
    </section>
  );
}

export function PluginManagerDetailCard({
  plugin,
  locale,
  presentation = 'v1',
  busy = false,
  onSaveConfig,
  onOperationChange,
  configurationValidationRequest = 0,
  configurationSaved = false,
}: {
  plugin: PluginManagerDesignFixture;
  locale: string;
  presentation?: PluginManagerPresentation;
  busy?: boolean;
  onSaveConfig?: (updates: readonly { key: string; value: string | null }[]) => void;
  onOperationChange?: () => void;
  configurationValidationRequest?: number;
  configurationSaved?: boolean;
}) {
  const installed = plugin.artifact === 'installed';
  const description = resolvePluginDescription(plugin.description, locale);
  const capabilityItems = capabilityDocItems(plugin, presentation);
  const capabilityGroups = groupCapabilityDocs(capabilityItems);
  const closureLabel = dependencyClosureLabel(plugin);

  return (
    <article data-testid="plugin-manager-detail" className={settingsResourceCardClass}>
      <div className="space-y-5 p-4">
        <section className="space-y-2.5" data-plugin-detail-section="identity">
          <SectionHeading>插件标识</SectionHeading>
          <div className={`${settingsResourceRowClass} w-full px-0 py-0`}>
            <PluginVisual icon={plugin.icon} iconBg={plugin.iconBg} name={plugin.displayName} size="large" />
            <div className="min-w-0 flex-1">
              <SettingsText as="h3" variant="sm" tone="default" className="font-semibold">
                {plugin.displayName}
              </SettingsText>
              <SettingsText as="p" variant="xs" tone="muted" className="mt-0.5 break-all">
                {plugin.installedVersion ?? plugin.availableVersion} · {plugin.packageName} · {plugin.publisher}
              </SettingsText>
              {closureLabel === undefined ? null : (
                <SettingsText as="p" variant="xs" tone="muted" className="mt-0.5">
                  {closureLabel}
                </SettingsText>
              )}
            </div>
          </div>
        </section>

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

        <PluginManagerConfigurationSection
          plugin={plugin}
          presentation={presentation}
          renderBefore={
            presentation === 'v2'
              ? (operations) => (
                  <PluginManagerDetailPrelude plugin={plugin} description={description} operations={operations} />
                )
              : undefined
          }
          busy={busy}
          onSaveConfig={onSaveConfig}
          onOperationChange={onOperationChange}
          validationRequest={configurationValidationRequest}
          saved={configurationSaved}
        />

        {plugin.bindings !== undefined && (
          <PluginManagerBindings
            key={plugin.id}
            pluginId={plugin.id}
            bindings={plugin.bindings}
            onChange={onOperationChange}
          />
        )}

        <CapabilityDocumentation
          plugin={plugin}
          installed={installed}
          groups={capabilityGroups}
          presentation={presentation}
        />
      </div>
    </article>
  );
}
