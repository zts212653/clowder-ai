'use client';
import type {
  PluginManagerContributionToolsResponse,
  PluginManagerDetailResponse,
  PluginManagerDocumentationResponse,
  PluginManagerListResponse,
} from '@cat-cafe/shared';
import { useRef } from 'react';
import { mutationRequestOptions } from '@/components/settings/plugin-manager/plugin-manager-mutation-options';
import { request, write } from './owner-api';
import { readPluginSpaces } from './plugin-spaces';

interface EnvironmentSummary {
  categories: Record<string, string>;
  paths: {
    projectRoot: string;
    homeDir: string;
    dataDirs: {
      auditLogs: string;
      runtimeLogs: string;
      cliArchive: string;
      redisDevSandbox: string;
      uploads: string;
    };
  };
  variables: {
    name: string;
    description: string;
    defaultValue: string;
    category: string;
    sensitive: boolean;
    currentValue: string | null;
    runtimeEditable?: boolean;
    restartRequired?: boolean;
    allowedValues?: string[];
    settingsGroup?: string;
    label?: string;
    booleanSemantics?: {
      defaultOn: boolean;
      trueWhen?: 'parseBoolEnv' | 'exactTrue' | 'exactOne' | 'notZero';
    };
  }[];
}

interface CapabilityAudit {
  entries: {
    timestamp: string;
    capabilityId: string;
    action: string;
    userId: string;
    before: { type: string } | null;
    after: { type: string } | null;
  }[];
}
interface MarketplaceSources {
  sources: {
    id: string;
    url: string;
    branch?: string;
    commit?: string;
    status: string;
    error?: string;
    origin: string;
  }[];
}
interface HookStatus {
  status: string;
  targets: { name: string; reason: string }[];
}
interface Connectivity {
  ok: boolean;
  skipped?: boolean;
  error?: string;
  message?: string;
}
interface PageActionOwner {
  kind: string;
  requestMessageId?: string;
  requestText?: string;
  pageUrl?: string;
  pageSelection?: boolean;
  state?: string;
  preview?: {
    previewId: string;
    field: string;
    operation: string;
    permissionScope: string;
    expiresAtMs: number;
    value?: string;
  };
  result?: { status: string };
}
interface PluginPermissions {
  revision: number | null;
  whitelistEnabled: boolean;
  commandAdminOnly: boolean;
  adminOpenIds: string[];
  allowedGroups: { externalChatId: string; label?: string; addedAt: number }[];
}

/** Raw settings receipts join the host push; the console projects their held copy. */
export function useSettingsBindings() {
  const data = useRef({
    env: null as EnvironmentSummary | null,
    system: null as { groups: Record<string, string>; variables: EnvironmentSummary['variables'] } | null,
    envPending: [] as string[],
    follows: {} as Record<string, { state: string; accountRef?: string }>,
    plugins: null as PluginManagerListResponse | null,
    pluginFragments: {} as Record<string, unknown>,
    pluginDetails: {} as Record<string, PluginManagerDetailResponse['plugin']>,
    pluginDocumentation: {} as Record<string, PluginManagerDocumentationResponse>,
    pluginTools: {} as Record<string, PluginManagerContributionToolsResponse['tools']>,
    pluginLibraries: {} as Record<string, unknown[]>,
    pluginPermissions: {} as Record<string, PluginPermissions>,
    pluginPermissionsErrors: {} as Record<string, string>,
    audit: null as CapabilityAudit | null,
    auditError: '',
    marketSources: null as MarketplaceSources | null,
    marketError: '',
    hooks: null as HookStatus | null,
    hooksError: '',
    connections: {} as Record<string, Connectivity>,
    pageAction: null as PageActionOwner | null,
    pageActionPages: [] as { pageId: string; title: string; url: string }[],
    pageActionError: '',
  });
  const readPlugins = async () => {
    const [plugins, pdl] = await Promise.all([
      request<PluginManagerListResponse>('/api/plugin-manager/plugins'),
      readPluginSpaces(),
    ]);
    data.current = { ...data.current, plugins: plugins };
    data.current = { ...data.current, pluginFragments: pdl.fragments };
  };
  const readPlugin = async (id: string) => {
    const { plugin } = await request<PluginManagerDetailResponse>(
      `/api/plugin-manager/plugins/${encodeURIComponent(id)}`,
    );
    const documentation =
      plugin.artifact === 'installed'
        ? await request<PluginManagerDocumentationResponse>(
            `/api/plugin-manager/plugins/${encodeURIComponent(id)}/documentation`,
          )
        : {};
    data.current = {
      ...data.current,
      pluginDetails: { ...data.current.pluginDetails, [id]: plugin },
      pluginDocumentation: { ...data.current.pluginDocumentation, [id]: documentation },
    };
    data.current = {
      ...data.current,
      pluginLibraries: {
        ...data.current.pluginLibraries!,
        [id]: plugin.configFields.some((field: { kind: string }) => field.kind === 'records')
          ? (await request<{ libraries: { pluginId: string }[] }>('/api/agent-providers')).libraries.filter(
              (library) => library.pluginId === id,
            )
          : [],
      },
    };
    if (plugin.artifact === 'installed' && plugin.permissions) {
      try {
        data.current = {
          ...data.current,
          pluginPermissions: {
            ...data.current.pluginPermissions!,
            [id]: await request<PluginPermissions>(`/api/plugin-manager/plugins/${encodeURIComponent(id)}/permissions`),
          },
        };
        data.current = {
          ...data.current,
          pluginPermissionsErrors: { ...data.current.pluginPermissionsErrors!, [id]: '' },
        };
      } catch (error) {
        data.current = {
          ...data.current,
          pluginPermissionsErrors: { ...data.current.pluginPermissionsErrors!, [id]: (error as Error).message },
        };
      }
    }
  };
  const readPageAction = async (listPages: boolean) => {
    const owner = await request<PageActionOwner>('/api/concierge/page-action');
    data.current = { ...data.current, pageAction: owner };
    if (listPages) {
      data.current = {
        ...data.current,
        pageActionPages:
          owner.kind === 'available' && owner.pageSelection
            ? (
                await write<{ pages: typeof data.current.pageActionPages }>('/api/concierge/page-action/pages', {
                  requestMessageId: owner.requestMessageId,
                })
              ).pages
            : [],
      };
      // Listing choices can revoke a prior preview; hold the owner's resulting state.
      if (owner.kind === 'available' && owner.pageSelection)
        data.current = { ...data.current, pageAction: await request<PageActionOwner>('/api/concierge/page-action') };
    }
    data.current = { ...data.current, pageActionError: '' };
  };
  return {
    get data() {
      return data.current;
    },
    action: async (name: string, args: Record<string, string>) => {
      if (name === 'settingsCapAuditRead') {
        try {
          data.current = {
            ...data.current,
            audit: await request<CapabilityAudit>(
              `/api/capabilities/audit?${new URLSearchParams({ limit: '50', ...(args.projectPath ? { projectPath: args.projectPath } : {}) })}`,
            ),
          };
          data.current = { ...data.current, auditError: '' };
        } catch (error) {
          data.current = { ...data.current, auditError: (error as Error).message };
        }
      } else if (name === 'settingsMarketRead' || name === 'settingsMarketWrite') {
        try {
          if (name === 'settingsMarketWrite') {
            if (args.op === 'refresh') await write('/api/plugin-manager/marketplaces/refresh', {});
            else if (args.op === 'delete')
              await write(`/api/plugin-manager/marketplaces/${encodeURIComponent(args.id)}`, {}, 'DELETE');
            else await write('/api/plugin-manager/marketplaces', JSON.parse(args.value));
          }
          data.current = {
            ...data.current,
            marketSources: await request<MarketplaceSources>('/api/plugin-manager/marketplaces'),
          };
          data.current = { ...data.current, marketError: '' };
        } catch (error) {
          data.current = { ...data.current, marketError: (error as Error).message };
          if (name === 'settingsMarketWrite') throw error;
        }
      } else if (name === 'settingsHooksRead' || name === 'settingsHooksSync') {
        try {
          if (name === 'settingsHooksSync') await write('/api/agent-hooks/sync', {});
          data.current = { ...data.current, hooks: await request<HookStatus>('/api/agent-hooks/status') };
          data.current = { ...data.current, hooksError: '' };
        } catch (error) {
          data.current = { ...data.current, hooksError: (error as Error).message };
          if (name === 'settingsHooksSync') throw error;
        }
      } else if (name === 'settingsMemberConnection') {
        try {
          data.current = {
            ...data.current,
            connections: {
              ...data.current.connections!,
              [args.key]: await write<Connectivity>('/api/first-run/connectivity-test', JSON.parse(args.value)),
            },
          };
        } catch (error) {
          data.current = {
            ...data.current,
            connections: { ...data.current.connections!, [args.key]: { ok: false, error: (error as Error).message } },
          };
        }
      } else if (name === 'settingsPageActionRead' || name === 'settingsPageAction') {
        try {
          if (name === 'settingsPageAction') {
            const owner = data.current.pageAction!;
            await write(
              `/api/concierge/page-action${args.op === 'revoke' ? '' : `/${args.op}`}`,
              args.op === 'confirm' || args.op === 'revoke'
                ? { previewId: args.previewId }
                : {
                    requestMessageId: owner.requestMessageId,
                    ...(args.op === 'select' ? { pageId: args.pageId } : {}),
                  },
              args.op === 'revoke' ? 'DELETE' : 'POST',
            );
          }
          await readPageAction(name === 'settingsPageActionRead');
        } catch (error) {
          data.current = { ...data.current, pageActionError: (error as Error).message };
        }
      } else if (name === 'settingsPluginsRead') {
        await readPlugins();
      } else if (name === 'settingsPluginDetailRead') {
        await readPlugin(args.id);
      } else if (name === 'settingsPluginToolsRead') {
        const { tools } = await request<PluginManagerContributionToolsResponse>(
          `/api/plugin-manager/plugins/${encodeURIComponent(args.id)}/contributions/tools`,
        );
        data.current = { ...data.current, pluginTools: { ...data.current.pluginTools, [args.id]: tools } };
      } else if (name === 'settingsPluginRestart' || name === 'settingsPluginDisconnect') {
        const id = args.id,
          path = `/api/plugin-manager/plugins/${encodeURIComponent(id)}`;
        const operation = name === 'settingsPluginRestart' ? `${path}/repair` : `${path}/bindings/disconnect`;
        const body =
          name === 'settingsPluginRestart'
            ? {
                expectedRevision: data.current.plugins!.plugins.find((plugin) => plugin.pluginId === id)!
                  .lifecycleRevision,
              }
            : { key: args.key, threadId: args.threadId, createdAt: +args.createdAt, confirmed: true };
        await request(
          operation,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
          mutationRequestOptions(operation),
        );
        await readPlugins();
        await readPlugin(id);
      } else if (name === 'settingsPluginPermissionsSave') {
        await write(
          `/api/plugin-manager/plugins/${encodeURIComponent(args.id)}/permissions`,
          JSON.parse(args.value),
          'PUT',
        );
        await readPlugin(args.id);
      } else if (name === 'settingsEnvRead') {
        data.current = { ...data.current, env: await request<EnvironmentSummary>('/api/config/env-summary') };
      } else if (name === 'settingsSystemRead') {
        const system = await request<NonNullable<typeof data.current.system>>('/api/config/env-summary?surface=system');
        data.current = { ...data.current, system };
      } else if (name === 'settingsEnvSave') {
        const result = await write<{ summary: EnvironmentSummary['variables'] }>(
          '/api/config/env',
          { updates: [{ name: args.key, value: args.value }] },
          'PATCH',
        );
        data.current = { ...data.current, env: { ...data.current.env!, variables: result.summary } };
        data.current = {
          ...data.current,
          envPending: [
            ...new Set(
              data.current.envPending.concat(
                result.summary.filter((v) => v.name === args.key && v.restartRequired).map((v) => v.name),
              ),
            ),
          ],
        };
      } else if (name === 'settingsFollowRead') {
        const tool = args.clientId === 'openai' ? 'codex' : 'claude';
        data.current = {
          ...data.current,
          follows: {
            ...data.current.follows!,
            [args.clientId]: (
              await request<{ selection: { state: string; accountRef?: string } }>(`/api/accounts/${tool}/members`)
            ).selection,
          },
        };
      } else if (name === 'settingsPluginInstall') {
        const path = '/api/plugin-manager/plugins/install';
        await request(
          path,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: args.value },
          mutationRequestOptions(path),
        );
        data.current = {
          ...data.current,
          plugins: await request<PluginManagerListResponse>('/api/plugin-manager/plugins'),
        };
      } else if (name === 'platform:openUrl') {
        window.open(args.url, '_blank', 'noopener,noreferrer');
      } else return false;
      return true;
    },
  };
}
