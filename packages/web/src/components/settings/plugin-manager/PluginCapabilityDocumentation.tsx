import { ExternalLinkIcon } from '../../HubConfigIcons';
import { MarkdownContent } from '../../MarkdownContent';
import { SettingsText } from '../primitives/SettingsText';
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

// The full manifest remains available to Host consumers; this is the owner-facing capability view.
const userCapabilityKinds = new Set([
  'mcp',
  'skill',
  'schedule',
  'direct-tool',
  'limb',
  'ui',
  'content-editor-provider',
  'desktop-window',
]);

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
    if (!userCapabilityKinds.has(contribution.kind)) return [];
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

export function PluginCapabilityDocumentation({
  plugin,
  presentation,
}: {
  plugin: PluginManagerDesignFixture;
  presentation: PluginManagerPresentation;
}) {
  return (
    <CapabilityDocumentation
      plugin={plugin}
      installed={plugin.artifact === 'installed'}
      groups={groupCapabilityDocs(capabilityDocItems(plugin, presentation))}
      presentation={presentation}
    />
  );
}
