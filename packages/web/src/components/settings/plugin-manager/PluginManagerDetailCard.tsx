'use client';

import { resolvePluginDescription } from '@cat-cafe/shared';
import { ExternalLinkIcon } from '../../HubConfigIcons';
import { HubIcon } from '../../hub-icons';
import { MarkdownContent } from '../../MarkdownContent';
import { settingsResourceCardClass, settingsResourceRowClass } from '../../SettingsResourceCard';
import { SettingsText } from '../primitives/SettingsText';
import { PluginManagerConfigurationSection } from './PluginManagerConfigurationSection';
import { PluginVisual } from './PluginVisual';
import type { PluginManagerDesignFixture } from './plugin-manager-fixtures';

function SectionHeading({ children }: { children: string }) {
  return (
    <SettingsText as="h4" variant="xs" tone="muted" className="font-semibold">
      {children}
    </SettingsText>
  );
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
};

interface CapabilityDocItem {
  key: string;
  kind: string;
  name: string;
  description?: string;
}

function CapabilityDocRow({ item }: { item: CapabilityDocItem }) {
  return (
    <li className="list-disc">
      <SettingsText as="p" variant="sm" tone="secondary">
        <span className="font-medium text-cafe">{item.name}</span>
        {item.description === undefined ? null : <span> — {item.description}</span>}
      </SettingsText>
    </li>
  );
}

function capabilityDocItems(plugin: PluginManagerDesignFixture): CapabilityDocItem[] {
  return (plugin.contributions ?? []).flatMap((contribution) => {
    const tools =
      contribution.kind === 'mcp' ? (plugin.tools ?? []).filter((tool) => tool.contributionId === contribution.id) : [];
    if (tools.length > 0) {
      return tools.map((tool) => ({
        key: `${contribution.id}:${tool.name}`,
        kind: 'mcp',
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
      }));
    }
    return [
      {
        key: contribution.id,
        kind: contribution.kind,
        name: contribution.name,
        ...(contribution.description === undefined ? {} : { description: contribution.description }),
      },
    ];
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
}: {
  plugin: PluginManagerDesignFixture;
  installed: boolean;
  groups: readonly { kind: string; items: CapabilityDocItem[] }[];
}) {
  return (
    <section className="space-y-3" data-plugin-detail-section="capability-docs">
      <SectionHeading>能力说明</SectionHeading>
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
                {contributionKindLabel[kind] ?? kind}
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
  busy = false,
  onSaveConfig,
  configurationValidationRequest = 0,
  configurationSaved = false,
}: {
  plugin: PluginManagerDesignFixture;
  locale: string;
  busy?: boolean;
  onSaveConfig?: (updates: readonly { key: string; value: string | null }[]) => void;
  configurationValidationRequest?: number;
  configurationSaved?: boolean;
}) {
  const installed = plugin.artifact === 'installed';
  const description = resolvePluginDescription(plugin.description, locale);
  const capabilityItems = capabilityDocItems(plugin);
  const capabilityGroups = groupCapabilityDocs(capabilityItems);

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
            </div>
          </div>
        </section>

        <section className="space-y-2" data-plugin-detail-section="introduction">
          <SectionHeading>插件简介</SectionHeading>
          <SettingsText as="p" variant="sm" tone="secondary">
            {description}
          </SettingsText>
        </section>

        {plugin.diagnostic && (
          <div className="flex items-start gap-2 rounded-xl bg-conn-amber-bg px-3 py-2.5">
            <HubIcon name="alert-triangle" className="mt-0.5 h-4 w-4 shrink-0 text-conn-amber-text" />
            <SettingsText as="p" variant="sm" tone="amber">
              {plugin.diagnostic}
            </SettingsText>
          </div>
        )}

        <PluginManagerConfigurationSection
          plugin={plugin}
          busy={busy}
          onSaveConfig={onSaveConfig}
          validationRequest={configurationValidationRequest}
          saved={configurationSaved}
        />

        <CapabilityDocumentation plugin={plugin} installed={installed} groups={capabilityGroups} />
      </div>
    </article>
  );
}
