import type {
  PluginDescription,
  PluginIconSpec,
  PluginInfo,
  PluginManagerCapability,
  PluginManagerConfigField,
  PluginManagerDetail,
  ValueConfigField,
} from '@cat-cafe/shared';
import { resourceCapId } from '../PluginRegistry.js';
import type { PluginManagerCompatibilityPort } from '../plugin-manager-service.js';

export type PluginManagerCompatibilitySource = 'repository-local' | 'connector';
type CompatibilityConfigField = ValueConfigField & {
  readonly currentValue: string | null;
  readonly sensitive: boolean;
};

export interface PluginManagerCompatibilityRecord {
  readonly pluginId: string;
  readonly displayName: string;
  readonly version: string;
  readonly description?: PluginDescription;
  readonly icon?: PluginIconSpec;
  readonly iconBg?: string;
  readonly publisher?: string;
  readonly sourceAdapter: PluginManagerCompatibilitySource;
  readonly configured: boolean;
  readonly enabled: boolean;
  readonly live: boolean;
  readonly docsUrl?: string;
  readonly setupSteps?: readonly string[];
  readonly configFields: readonly CompatibilityConfigField[];
  readonly capabilities: readonly PluginManagerCapability[];
}

function projectCompatibilityConfigField(field: CompatibilityConfigField): PluginManagerConfigField {
  const common = {
    key: field.envName,
    label: field.label,
    required: field.required,
    currentValue: field.currentValue,
    sensitive: field.sensitive,
  };
  switch (field.type) {
    case 'toggle':
      return { ...common, kind: 'boolean', ...(field.default === undefined ? {} : { default: field.default }) };
    case 'select':
      return {
        ...common,
        kind: 'select',
        options: field.options.map((option) => ({ ...option })),
        ...(field.default === undefined ? {} : { default: field.default }),
      };
    case 'list':
      return {
        ...common,
        kind: 'list',
        ...(field.default === undefined ? {} : { default: [...field.default] }),
      };
    case 'input':
      return {
        ...common,
        kind: field.sensitive ? 'secret' : 'string',
        ...(field.default === undefined ? {} : { default: field.default }),
      };
  }
}

export interface PluginManagerCompatibilityProvider {
  list(): Promise<readonly PluginManagerCompatibilityRecord[]>;
}

export interface RepositoryPluginManagerCompatibilityProviderOptions {
  readonly loadSuppressedPluginIds?: () => Promise<readonly string[]> | readonly string[];
}

function isManagerCapabilityKind(value: string): value is PluginManagerCapability['kind'] {
  return value === 'skill' || value === 'mcp' || value === 'limb' || value === 'schedule';
}

/**
 * Projects the existing repository manifest registry into the unified Manager.
 * These rows remain read-only until Train C materializes them in Host inventory.
 */
export class RepositoryPluginManagerCompatibilityProvider implements PluginManagerCompatibilityProvider {
  constructor(
    private readonly loadPlugins: () => Promise<readonly PluginInfo[]> | readonly PluginInfo[],
    private readonly options: RepositoryPluginManagerCompatibilityProviderOptions = {},
  ) {}

  async list(): Promise<readonly PluginManagerCompatibilityRecord[]> {
    const [plugins, suppressedPluginIds] = await Promise.all([this.loadPlugins(), this.loadSuppressedPluginIds()]);
    const suppressed = new Set(suppressedPluginIds);
    return plugins
      .filter((plugin) => !suppressed.has(plugin.id))
      .map((plugin) => {
        const capabilities: PluginManagerCapability[] = plugin.resources.flatMap((resource) => {
          if (!isManagerCapabilityKind(resource.type)) return [];
          return [
            {
              id: resourceCapId(plugin.id, resource),
              kind: resource.type,
              name: resource.name ?? resource.path ?? resource.type,
              active: resource.enabled,
            },
          ];
        });
        const runtimeEnabled = plugin.status === 'enabled' || plugin.status === 'partial';
        return {
          pluginId: plugin.id,
          displayName: plugin.name,
          version: plugin.version,
          ...(plugin.description === undefined ? {} : { description: plugin.description }),
          ...(plugin.icon === undefined ? {} : { icon: plugin.icon }),
          ...(plugin.iconBg === undefined ? {} : { iconBg: plugin.iconBg }),
          publisher: 'Clowder AI',
          sourceAdapter: 'repository-local' as const,
          configured: plugin.configured,
          enabled: runtimeEnabled,
          live: runtimeEnabled,
          ...(plugin.docsUrl === undefined ? {} : { docsUrl: plugin.docsUrl }),
          ...(plugin.setupSteps === undefined ? {} : { setupSteps: [...plugin.setupSteps] }),
          configFields: plugin.config.map((field) => ({ ...field })),
          capabilities,
        };
      });
  }

  private async loadSuppressedPluginIds(): Promise<readonly string[]> {
    try {
      return (await this.options.loadSuppressedPluginIds?.()) ?? [];
    } catch {
      return [];
    }
  }
}

function projectCompatibilityRecord(record: PluginManagerCompatibilityRecord): PluginManagerDetail {
  const capabilities = record.capabilities.map((capability) => ({ ...capability }));
  const repositoryLocal = record.sourceAdapter === 'repository-local';
  const source = repositoryLocal
    ? {
        kind: 'compatibility' as const,
        adapter: 'repository-local' as const,
        packageName: `repository-local:${record.pluginId}`,
        trust: 'first-party' as const,
      }
    : {
        kind: 'compatibility' as const,
        adapter: 'connector' as const,
        packageName: `connector:${record.pluginId}`,
        trust: 'local-trusted' as const,
      };
  return {
    pluginId: record.pluginId,
    pluginInstanceId: null,
    displayName: record.displayName,
    ...(record.description === undefined ? {} : { description: record.description }),
    ...(record.icon === undefined ? {} : { icon: record.icon }),
    ...(record.iconBg === undefined ? {} : { iconBg: record.iconBg }),
    publisher: record.publisher ?? (repositoryLocal ? 'Clowder AI' : 'Local Host'),
    source,
    availableVersion: record.version,
    installedVersion: record.version,
    packageDigest: null,
    artifact: 'installed',
    config: record.configured ? 'ready' : 'incomplete',
    auth: 'not-required',
    intent: record.enabled ? 'enabled' : 'disabled',
    live: record.live ? 'running' : 'stopped',
    lifecycleRevision: null,
    capabilitySummary: capabilities.map(({ id, kind, name, active }) => ({ id, kind, name, active })),
    actions: {
      install: false,
      setEnabled: false,
      uninstall: false,
      blockingReasons: ['compatibility-read-only'],
    },
    capabilities,
    contributions: capabilities.map(({ id, kind, name, description }) => ({
      id,
      kind,
      name,
      ...(description === undefined ? {} : { description }),
    })),
    ...(record.docsUrl === undefined ? {} : { docsUrl: record.docsUrl }),
    ...(record.setupSteps === undefined ? {} : { setupSteps: [...record.setupSteps] }),
    configFields: record.configFields.map(projectCompatibilityConfigField),
  };
}

/** Train C deletes this adapter after every legacy source is materialized in Host inventory. */
export class PluginManagerCompatibilityAdapter implements PluginManagerCompatibilityPort {
  constructor(private readonly providers: readonly PluginManagerCompatibilityProvider[]) {}

  async list(): Promise<readonly PluginManagerDetail[]> {
    const records = await Promise.all(this.providers.map((provider) => provider.list()));
    const byPluginId = new Map<string, PluginManagerDetail>();
    for (const record of records.flat()) {
      if (!byPluginId.has(record.pluginId)) byPluginId.set(record.pluginId, projectCompatibilityRecord(record));
    }
    return [...byPluginId.values()];
  }
}

export class CompositePluginManagerCompatibilityPort implements PluginManagerCompatibilityPort {
  constructor(private readonly ports: readonly PluginManagerCompatibilityPort[]) {}

  async list(): Promise<readonly PluginManagerDetail[]> {
    const rows = await Promise.all(this.ports.map((port) => port.list()));
    const byPluginId = new Map<string, PluginManagerDetail>();
    for (const row of rows.flat()) {
      if (!byPluginId.has(row.pluginId)) byPluginId.set(row.pluginId, row);
    }
    return [...byPluginId.values()];
  }
}
