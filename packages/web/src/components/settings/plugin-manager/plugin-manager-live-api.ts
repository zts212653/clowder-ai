import type {
  PluginManagerContributionToolsResponse,
  PluginManagerDetail,
  PluginManagerDetailResponse,
  PluginManagerDocumentationResponse,
  PluginManagerListItem,
  PluginManagerListResponse,
} from '@cat-cafe/shared';
import { apiFetch } from '@/utils/api-client';
import type { PluginManagerDesignFixture, PluginManagerReadmeState } from './plugin-manager-fixtures';

export type ConsolePluginManagerDetail = PluginManagerDetail & {
  readonly readme: Exclude<PluginManagerReadmeState, { readonly state: 'loading' }>;
  readonly tools?: PluginManagerContributionToolsResponse['tools'];
};

export type DetailLoadState =
  | { readonly state: 'idle' }
  | { readonly state: 'loading'; readonly pluginId: string }
  | { readonly state: 'ready'; readonly pluginId: string; readonly detail: ConsolePluginManagerDetail }
  | { readonly state: 'unavailable'; readonly pluginId: string };

export type ConfigurationUpdate = { readonly key: string; readonly value: string | null };

function packageName(plugin: PluginManagerListItem): string {
  return plugin.source.packageName ?? plugin.pluginId;
}

function fixtureDetail(detail: ConsolePluginManagerDetail | undefined): Partial<PluginManagerDesignFixture> {
  if (!detail) return {};
  return {
    ...(detail.contributions === undefined
      ? {}
      : { contributions: detail.contributions.map((contribution) => ({ ...contribution })) }),
    ...(detail.tools === undefined
      ? {}
      : {
          tools: detail.tools.map(({ contributionId, name, description }) => ({
            contributionId,
            name,
            ...(description === undefined ? {} : { description }),
          })),
        }),
    readme: detail.readme,
    ...(detail.setupSteps === undefined ? {} : { setupSteps: detail.setupSteps }),
    ...(detail.docsUrl === undefined ? {} : { docsUrl: detail.docsUrl }),
    ...(detail.configFields === undefined ? {} : { configFields: detail.configFields }),
  };
}

export function designFixture(
  plugin: PluginManagerListItem,
  detail: ConsolePluginManagerDetail | undefined,
  readme: PluginManagerReadmeState,
): PluginManagerDesignFixture {
  const capabilities = detail?.capabilities ?? plugin.capabilitySummary;
  return {
    id: plugin.pluginId,
    displayName: plugin.displayName,
    description: plugin.description ?? plugin.displayName,
    icon: plugin.icon ?? 'blocks',
    ...(plugin.iconBg === undefined ? {} : { iconBg: plugin.iconBg }),
    publisher: plugin.publisher ?? (plugin.source.trust === 'official' ? 'Clowder AI' : 'Local Host'),
    packageName: packageName(plugin),
    source: plugin.source.kind === 'catalog' ? 'catalog' : 'local',
    trust: plugin.source.trust === 'official' ? 'official' : 'local-trusted',
    ...(plugin.source.kind === 'compatibility' ? { sourceAdapter: plugin.source.adapter } : {}),
    availableVersion: plugin.availableVersion ?? plugin.installedVersion ?? 'unknown',
    installedVersion: plugin.installedVersion,
    artifact: plugin.artifact,
    config: plugin.config,
    auth: plugin.auth,
    intent: plugin.intent,
    live: plugin.live,
    readme,
    capabilities: capabilities.map((capability) => ({
      name: capability.name,
      description:
        'description' in capability && typeof capability.description === 'string'
          ? capability.description
          : capability.name,
    })),
    ...fixtureDetail(detail),
    ...(plugin.diagnostic === undefined ? {} : { diagnostic: plugin.diagnostic.message }),
    actions: plugin.actions,
  };
}

export async function responseError(response: Response, fallback: string): Promise<{ message: string; code?: string }> {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
  return {
    message: typeof body.error === 'string' && body.error.length > 0 ? body.error : fallback,
    ...(typeof body.code === 'string' ? { code: body.code } : {}),
  };
}

function isListResponse(value: unknown): value is PluginManagerListResponse {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { plugins?: unknown; catalog?: { status?: unknown } };
  return Array.isArray(candidate.plugins) && typeof candidate.catalog?.status === 'string';
}

function isDetailResponse(value: unknown): value is PluginManagerDetailResponse {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { plugin?: { pluginId?: unknown }; catalog?: { status?: unknown } };
  return typeof candidate.plugin?.pluginId === 'string' && typeof candidate.catalog?.status === 'string';
}

function isDocumentationResponse(value: unknown): value is PluginManagerDocumentationResponse {
  if (!value || typeof value !== 'object') return false;
  const readmeMarkdown = (value as { readmeMarkdown?: unknown }).readmeMarkdown;
  return readmeMarkdown === undefined || typeof readmeMarkdown === 'string';
}

function isContributionToolsResponse(value: unknown): value is PluginManagerContributionToolsResponse {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { pluginId?: unknown; tools?: unknown };
  return (
    typeof candidate.pluginId === 'string' &&
    Array.isArray(candidate.tools) &&
    candidate.tools.every(
      (tool) =>
        tool !== null &&
        typeof tool === 'object' &&
        typeof (tool as { contributionId?: unknown }).contributionId === 'string' &&
        typeof (tool as { name?: unknown }).name === 'string',
    )
  );
}

async function fetchDocumentation(path: string): Promise<ConsolePluginManagerDetail['readme']> {
  const response = await apiFetch(`${path}/documentation`).catch(() => undefined);
  if (response === undefined) return { state: 'unavailable' };
  if (response.status === 404) return { state: 'absent' };
  if (!response.ok) return { state: 'unavailable' };
  const value: unknown = await response.json().catch(() => undefined);
  if (!isDocumentationResponse(value)) return { state: 'unavailable' };
  return value.readmeMarkdown === undefined
    ? { state: 'absent' }
    : { state: 'available', markdown: value.readmeMarkdown };
}

async function fetchContributionTools(
  path: string,
): Promise<PluginManagerContributionToolsResponse['tools'] | undefined> {
  const response = await apiFetch(`${path}/contributions/tools`).catch(() => undefined);
  if (!response?.ok) return undefined;
  const value: unknown = await response.json().catch(() => undefined);
  return isContributionToolsResponse(value) ? value.tools : undefined;
}

export async function fetchManagerDetail(
  pluginId: string,
  afterMutation: boolean,
): Promise<ConsolePluginManagerDetail> {
  const path = `/api/plugin-manager/plugins/${encodeURIComponent(pluginId)}`;
  const [response, documentation] = await Promise.all([
    afterMutation ? apiFetch(path, undefined, { afterCurrentGet: true }) : apiFetch(path),
    fetchDocumentation(path),
  ]);
  if (!response.ok) throw new Error(`detail request failed (${response.status})`);
  const value: unknown = await response.json();
  if (!isDetailResponse(value)) throw new Error('detail response is invalid');
  const tools =
    value.plugin.artifact === 'installed' && value.plugin.live === 'running' ? await fetchContributionTools(path) : [];
  return {
    ...value.plugin,
    readme: documentation,
    ...(tools === undefined ? {} : { tools }),
  };
}

export async function fetchManagerList(search: string, afterMutation: boolean): Promise<PluginManagerListResponse> {
  const normalized = search.trim();
  const path =
    normalized.length === 0
      ? '/api/plugin-manager/plugins'
      : `/api/plugin-manager/plugins/search?q=${encodeURIComponent(normalized)}`;
  const response = afterMutation ? await apiFetch(path, undefined, { afterCurrentGet: true }) : await apiFetch(path);
  if (!response.ok) throw new Error(`list request failed (${response.status})`);
  const value: unknown = await response.json();
  if (!isListResponse(value)) throw new Error('list response is invalid');
  return value;
}

function legacyConfigurationUpdates(updates: readonly ConfigurationUpdate[]) {
  return updates.map(({ key, value }) => ({ name: key, value }));
}

export function configurationRequest(
  plugin: PluginManagerListItem | undefined,
  updates: readonly ConfigurationUpdate[],
): { readonly path: string; readonly init: RequestInit } | undefined {
  if (!plugin || plugin.artifact !== 'installed') return undefined;
  const encodedId = encodeURIComponent(plugin.pluginId);
  if (plugin.source.kind === 'compatibility') {
    const repositoryLocal = plugin.source.adapter === 'repository-local';
    return {
      path: repositoryLocal ? `/api/plugins/${encodedId}/config` : `/api/connectors/${encodedId}/config`,
      init: {
        method: repositoryLocal ? 'POST' : 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          repositoryLocal
            ? { updates: legacyConfigurationUpdates(updates) }
            : { fields: legacyConfigurationUpdates(updates) },
        ),
      },
    };
  }
  if (plugin.lifecycleRevision === null) return undefined;
  return {
    path: `/api/plugin-manager/plugins/${encodedId}/contributions/configuration`,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: plugin.lifecycleRevision, updates }),
    },
  };
}

export function detailProjection(
  pluginId: string,
  detailState: DetailLoadState,
): { readonly detail?: ConsolePluginManagerDetail; readonly readme: PluginManagerReadmeState } {
  if (detailState.state === 'ready' && detailState.pluginId === pluginId) {
    return { detail: detailState.detail, readme: detailState.detail.readme };
  }
  if (detailState.state === 'unavailable' && detailState.pluginId === pluginId) {
    return { readme: { state: 'unavailable' } };
  }
  return { readme: { state: 'loading' } };
}
