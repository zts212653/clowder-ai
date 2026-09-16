import { createHash } from 'node:crypto';
import type { AgentService, ProviderNativeCapabilityArtifact, ProviderNativeCapabilitySource } from '../../types.js';
import {
  boundedArrayCount,
  boundedRecordKeyCount,
  type IngestionBudget,
  type JsonRecord,
  MAX_ARTIFACTS,
  optionalArray,
  pushIssue,
  record,
  requiredArray,
  takeArray,
  takeArtifacts,
} from './CodexCapabilityIngestion.js';

interface CollectOptions {
  readonly cwd: string;
  readonly providerVersion: string;
  readonly observedAt?: string;
  readonly request: (method: string, params: JsonRecord) => Promise<unknown>;
}

const MAX_ID = 160;
const MAX_NAME = 160;
const MAX_DESCRIPTION = 500;
const MCP_RUNTIME_STATUSES = new Set([
  'notStarted',
  'starting',
  'connected',
  'authenticationRequired',
  'failed',
  'cancelled',
  'disabled',
]);
const READ_REQUESTS = [
  ['skills/list', (cwd: string) => ({ cwds: [cwd], forceReload: false }), 'data'],
  ['app/list', () => ({ cursor: null, forceRefetch: false, limit: 100 }), 'data'],
  ['app/installed', () => ({ forceRefresh: false }), 'apps'],
  ['plugin/list', (cwd: string) => ({ cwds: [cwd], forceRefetch: false }), 'marketplaces'],
  ['plugin/installed', (cwd: string) => ({ cwds: [cwd], installSuggestionPluginNames: [] }), 'marketplaces'],
  ['mcpServerStatus/list', () => ({ cursor: null, detail: 'full', limit: 100 }), 'data'],
] as const;
type ReadMethod = (typeof READ_REQUESTS)[number][0];

export async function collectCodexCapabilitySource(options: CollectOptions): Promise<ProviderNativeCapabilitySource> {
  const issues: string[] = [];
  const settled = await Promise.allSettled(
    READ_REQUESTS.map(([method, params]) => options.request(method, params(options.cwd))),
  );
  const values = new Map<ReadMethod, unknown>();
  const collections = new Map<ReadMethod, unknown[]>();
  settled.forEach((result, index) => {
    const [method, , collectionKey] = READ_REQUESTS[index];
    if (result.status === 'fulfilled') {
      values.set(method, result.value);
      collections.set(
        method,
        requiredArray(record(result.value)?.[collectionKey], issues, `${method} ${collectionKey}`),
      );
    } else pushIssue(issues, method + ' unavailable');
  });

  const collection = (method: ReadMethod): unknown[] => collections.get(method) ?? [];
  reportMarketplaceLoadErrors(values.get('plugin/list'), 'plugin/list', issues);
  reportMarketplaceLoadErrors(values.get('plugin/installed'), 'plugin/installed', issues);
  const artifactBudget: IngestionBudget = { remaining: MAX_ARTIFACTS };
  const artifacts = deduplicateArtifacts([
    ...readSkills(collection('skills/list'), issues, artifactBudget),
    ...readApps(collection('app/list'), collection('app/installed'), issues, artifactBudget),
    ...readPlugins(collection('plugin/list'), collection('plugin/installed'), issues, artifactBudget),
    ...readMcpServers(collection('mcpServerStatus/list'), issues, artifactBudget),
  ]);

  const succeeded = settled.filter((result) => result.status === 'fulfilled').length;
  return {
    availability: succeeded === 0 ? 'unavailable' : issues.length > 0 ? 'degraded' : 'live',
    providerVersion: boundedString(options.providerVersion, MAX_NAME) ?? 'unknown',
    observedAt: options.observedAt ?? new Date().toISOString(),
    artifacts,
    issues,
  };
}

export function selectCodexCapabilitySourceService(services: Iterable<AgentService>): AgentService | undefined {
  for (const service of services) {
    const capability = service.freshnessCarrierCapability?.();
    if (
      capability?.provider === 'openai_codex' &&
      capability.carrier === 'codex_app_server' &&
      service.requestNativeCapabilitySource
    ) {
      return service;
    }
  }
  return undefined;
}

function reportMarketplaceLoadErrors(value: unknown, method: string, issues: string[]): void {
  const errors = optionalArray(record(value)?.marketplaceLoadErrors, issues, `${method} marketplaceLoadErrors`);
  if (errors.length > 0) pushIssue(issues, `${method} reported marketplace load errors`);
}

function readSkills(value: unknown[], issues: string[], budget: IngestionBudget): ProviderNativeCapabilityArtifact[] {
  const artifacts: ProviderNativeCapabilityArtifact[] = [];
  for (const groupValue of takeArray(value, 20, issues, 'skills/list groups')) {
    const group = record(groupValue);
    if (!group) {
      pushIssue(issues, 'skills/list returned an unknown group');
      continue;
    }
    const errors = requiredArray(group.errors, issues, 'skills/list errors');
    if (errors.length > 0) pushIssue(issues, 'skills/list reported provider scan errors');
    for (const skillValue of takeArtifacts(group.skills, budget, issues, 'skills/list skills')) {
      const skill = record(skillValue);
      const rawName = identityString(skill?.name);
      if (!skill || !rawName) {
        pushIssue(issues, 'skills/list returned an unknown skill');
        continue;
      }
      const scope = boundedString(skill.scope, 32) ?? 'unknown';
      artifacts.push({
        id: artifactId('skill', scope + ':' + rawName),
        kind: 'skill',
        name: boundedString(rawName, MAX_NAME) ?? 'Codex skill',
        description: boundedString(skill.description, MAX_DESCRIPTION) ?? 'Codex skill',
        sourceLocator: 'codex:skill/' + encodeURIComponent(scope) + '/' + encodeURIComponent(publicIdentity(rawName)),
        trustLevel: scope === 'system' || scope === 'admin' ? 'official' : 'community',
        publisher: 'Codex provider',
        lifecycle: { installed: true, enabled: skill.enabled === true, maturity: 'stable' },
      });
    }
  }
  return artifacts;
}

function readApps(
  listValue: unknown[],
  installedValue: unknown[],
  issues: string[],
  budget: IngestionBudget,
): ProviderNativeCapabilityArtifact[] {
  const installed = new Map<string, JsonRecord>();
  for (const value of takeArray(installedValue, MAX_ARTIFACTS, issues, 'app/installed apps')) {
    const item = record(value);
    const id = identityString(item?.id);
    if (item && id) installed.set(id, item);
  }
  const artifacts: ProviderNativeCapabilityArtifact[] = [];
  for (const appValue of takeArtifacts(listValue, budget, issues, 'app/list apps')) {
    const app = record(appValue);
    const rawId = identityString(app?.id);
    const name = boundedString(app?.name, MAX_NAME);
    if (!app || !rawId || !name) {
      pushIssue(issues, 'app/list returned an unknown app');
      continue;
    }
    const branding = record(app.branding);
    const metadata = record(app.appMetadata);
    const runtime = installed.get(rawId);
    const versionRef = boundedString(metadata?.version, 80);
    artifacts.push({
      id: artifactId('app', rawId),
      kind: 'app',
      name,
      description: boundedString(app.description, MAX_DESCRIPTION) ?? 'Codex app',
      sourceLocator: 'codex:app/' + encodeURIComponent(publicIdentity(rawId)),
      trustLevel: branding?.isDiscoverableApp === true ? 'verified' : 'community',
      publisher: boundedString(branding?.developer, MAX_NAME) ?? 'Codex provider',
      ...(versionRef ? { versionRef } : {}),
      lifecycle: {
        installed: !!runtime,
        enabled: runtime ? runtime.enabled === true : app.isEnabled === true,
        accessible: app.isAccessible === true,
        callable: runtime?.callable === true,
        maturity: 'experimental',
      },
    });
  }
  return artifacts;
}

function readPlugins(
  listValue: unknown[],
  installedValue: unknown[],
  issues: string[],
  budget: IngestionBudget,
): ProviderNativeCapabilityArtifact[] {
  const installedIds = collectPluginIds(installedValue, issues);
  const artifacts: ProviderNativeCapabilityArtifact[] = [];
  for (const marketplaceValue of takeArray(listValue, 50, issues, 'plugin/list marketplaces')) {
    const marketplace = record(marketplaceValue);
    const marketplaceName = boundedString(marketplace?.name, MAX_NAME) ?? 'provider';
    for (const pluginValue of takeArtifacts(marketplace?.plugins, budget, issues, 'plugin/list plugins')) {
      const plugin = record(pluginValue);
      const rawId = identityString(plugin?.id);
      const name = boundedString(plugin?.name, MAX_NAME);
      if (!plugin || !rawId || !name) {
        pushIssue(issues, 'plugin/list returned an unknown plugin');
        continue;
      }
      const ui = record(plugin.interface);
      const versionRef = boundedString(plugin.version, 80);
      artifacts.push({
        id: artifactId('plugin', rawId),
        kind: 'plugin',
        name: boundedString(ui?.displayName, MAX_NAME) ?? name,
        description:
          boundedString(ui?.shortDescription, MAX_DESCRIPTION) ??
          boundedString(ui?.longDescription, MAX_DESCRIPTION) ??
          'Codex plugin',
        sourceLocator:
          'codex:plugin/' + encodeURIComponent(marketplaceName) + '/' + encodeURIComponent(publicIdentity(rawId)),
        trustLevel: record(plugin.source)?.type === 'remote' ? 'verified' : 'community',
        publisher: boundedString(ui?.developerName, MAX_NAME) ?? marketplaceName,
        ...(versionRef ? { versionRef } : {}),
        lifecycle: {
          installed: plugin.installed === true || installedIds.has(rawId),
          enabled: plugin.enabled === true,
          authPolicy: boundedString(plugin.authPolicy, 40),
          maturity: 'stable',
        },
      });
    }
  }
  return artifacts;
}

function collectPluginIds(value: unknown[], issues: string[]): Set<string> {
  const ids = new Set<string>();
  const budget: IngestionBudget = { remaining: MAX_ARTIFACTS };
  for (const marketplaceValue of takeArray(value, 50, issues, 'plugin/installed marketplaces')) {
    const plugins = record(marketplaceValue)?.plugins;
    for (const pluginValue of takeArtifacts(plugins, budget, issues, 'plugin/installed plugins')) {
      const id = identityString(record(pluginValue)?.id);
      if (id) ids.add(id);
    }
  }
  return ids;
}

function readMcpServers(
  value: unknown[],
  issues: string[],
  budget: IngestionBudget,
): ProviderNativeCapabilityArtifact[] {
  const artifacts: ProviderNativeCapabilityArtifact[] = [];
  for (const serverValue of takeArtifacts(value, budget, issues, 'mcpServerStatus/list servers')) {
    const server = record(serverValue);
    const rawName = identityString(server?.name);
    if (!server || !rawName) {
      pushIssue(issues, 'mcpServerStatus/list returned an unknown server');
      continue;
    }
    const info = record(server.serverInfo);
    const displayName =
      boundedString(info?.title, MAX_NAME) ??
      boundedString(info?.name, MAX_NAME) ??
      boundedString(rawName, MAX_NAME) ??
      'Configured Codex MCP server';
    const versionRef = boundedString(info?.version, 80);
    const pluginId = boundedString(server.pluginId, MAX_ID);
    const runtimeStatus = boundedString(server.runtimeStatus, 40);
    const enabled = runtimeStatus && MCP_RUNTIME_STATUSES.has(runtimeStatus) ? runtimeStatus !== 'disabled' : undefined;
    artifacts.push({
      id: artifactId('mcp', rawName),
      kind: 'mcp_server',
      name: displayName,
      description: boundedString(info?.description, MAX_DESCRIPTION) ?? 'Configured Codex MCP server',
      sourceLocator: 'codex:mcp/' + encodeURIComponent(publicIdentity(rawName)),
      trustLevel: 'community',
      publisher: 'Codex configuration',
      ...(versionRef ? { versionRef } : {}),
      lifecycle: {
        installed: true,
        ...(enabled !== undefined ? { enabled } : {}),
        authStatus: boundedString(server.authStatus, 40) ?? 'unknown',
        ...(runtimeStatus ? { runtimeStatus } : {}),
        toolCount: boundedRecordKeyCount(server.tools, 500, issues, 'MCP tools'),
        resourceCount: boundedArrayCount(server.resources, 500, issues, 'MCP resources'),
        resourceTemplateCount: boundedArrayCount(server.resourceTemplates, 500, issues, 'MCP resource templates'),
        ...(pluginId ? { pluginId } : {}),
      },
    });
  }
  return artifacts;
}

function deduplicateArtifacts(artifacts: ProviderNativeCapabilityArtifact[]): ProviderNativeCapabilityArtifact[] {
  const byId = new Map<string, ProviderNativeCapabilityArtifact>();
  for (const artifact of artifacts) if (!byId.has(artifact.id)) byId.set(artifact.id, artifact);
  return [...byId.values()];
}

function artifactId(kind: string, value: string): string {
  const prefix = `${kind}:`;
  const normalized = identityString(value) ?? 'unknown';
  return prefix + publicIdentity(normalized, MAX_ID - prefix.length);
}

function publicIdentity(value: string, max = MAX_ID): string {
  if (value.length <= max) return value;
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 16);
  return `${value.slice(0, Math.max(0, max - digest.length - 1))}~${digest}`;
}

function identityString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return normalized || undefined;
}

function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!normalized) return undefined;
  return normalized.slice(0, max);
}
