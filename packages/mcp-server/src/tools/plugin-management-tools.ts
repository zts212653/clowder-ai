import { isAbsolute } from 'node:path';
import type {
  PluginManagerInstallRequest,
  PluginManagerSetEnabledRequest,
  PluginManagerUninstallRequest,
} from '@cat-cafe/shared';
import { z } from 'zod';
import { defineMcpCanonicalFactory } from '../tool-governance-migration.js';
import { NO_CONFIG_ERROR } from './callback-tools.js';
import type { ToolResult } from './file-tools.js';
import { errorResult, successResult } from './file-tools.js';
import { resolveInvocationCredentials } from './invocation-auth.js';

const SPEC_REF = 'file:feature-specs/2026-09-01-f202-terminal-plugin-manager.md' as const;
const defineTool = defineMcpCanonicalFactory('plugin-management-tools.ts', undefined, {
  resourceFamily: 'plugin-manager',
  authority: 'callback-owner',
});

const pluginIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/)
  .describe('Canonical plugin id from plugin_list/plugin_search.');
const catalogIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/)
  .describe('Exact catalogId returned by plugin_list, plugin_search, or plugin_get.');
const lifecycleRevisionSchema = z
  .number()
  .int()
  .safe()
  .min(1)
  .describe('Exact lifecycleRevision returned by the latest plugin_list or plugin_get.');
const contributionIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  .describe('Exact active contribution id returned by plugin_list_tools.');
const contributionToolNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .describe('Exact dynamic tool name returned by plugin_list_tools.');
const canonicalDigestSchema = z
  .string()
  .refine((value) => {
    if (!value.startsWith('sha512-')) return false;
    const encoded = value.slice('sha512-'.length);
    const decoded = Buffer.from(encoded, 'base64');
    return decoded.byteLength === 64 && decoded.toString('base64') === encoded;
  }, 'Expected a canonical sha512 SRI digest.')
  .describe('Exact expectedDigest returned for the selected catalog release.');

const catalogInstallSchema = z
  .object({
    source: z.object({ kind: z.literal('catalog'), catalogId: catalogIdSchema }).strict(),
    expectedVersion: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .describe('Exact availableVersion returned for the selected catalog release.'),
    expectedDigest: canonicalDigestSchema,
  })
  .strict();
const localInstallSchema = z
  .object({
    source: z
      .object({
        kind: z.enum(['local-directory', 'local-archive']),
        path: z
          .string()
          .trim()
          .min(1)
          .max(4_096)
          .refine(isAbsolute, 'Local plugin path must be absolute.')
          .describe('Absolute local directory or .tgz archive path selected by the user.'),
      })
      .strict(),
  })
  .strict();
const pluginInstallRequestSchema = z
  .union([catalogInstallSchema, localInstallSchema])
  .describe('Closed Host Manager install request. Catalog installs are version/digest fenced.');

export const pluginListInputSchema = {};
export const pluginSearchInputSchema = {
  query: z.string().trim().min(1).max(200).describe('Search verified plugin metadata and capabilities.'),
};
export const pluginGetInputSchema = { pluginId: pluginIdSchema };
export const pluginListToolsInputSchema = { pluginId: pluginIdSchema };
export const pluginCallInputSchema = {
  pluginId: pluginIdSchema,
  contributionId: contributionIdSchema,
  toolName: contributionToolNameSchema,
  arguments: z
    .record(z.unknown())
    .describe('Arguments constructed from the exact inputSchema returned by plugin_list_tools.'),
};
export const pluginInstallInputSchema = { request: pluginInstallRequestSchema };
export const pluginSetEnabledInputSchema = {
  pluginId: pluginIdSchema,
  enabled: z.boolean().describe('True to enable, false to disable.'),
  expectedRevision: lifecycleRevisionSchema,
};
export const pluginUninstallInputSchema = {
  pluginId: pluginIdSchema,
  expectedRevision: lifecycleRevisionSchema,
};

export interface PluginManagerClient {
  list(): Promise<unknown>;
  search(query: string): Promise<unknown>;
  get(pluginId: string): Promise<unknown>;
  listTools(pluginId: string): Promise<unknown>;
  call(
    pluginId: string,
    contributionId: string,
    toolName: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
  install(request: PluginManagerInstallRequest): Promise<unknown>;
  setEnabled(pluginId: string, request: PluginManagerSetEnabledRequest): Promise<unknown>;
  uninstall(pluginId: string, request: PluginManagerUninstallRequest): Promise<unknown>;
}

export interface PluginManagerClientAuth {
  readonly apiUrl: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface PluginManagerHttpClientOptions {
  readonly fetchImpl?: typeof fetch;
  readonly resolveAuth?: () => PluginManagerClientAuth | null;
}

function resolveCallbackAuth(): PluginManagerClientAuth | null {
  const apiUrl = process.env.CAT_CAFE_API_URL?.trim();
  const { invocationId, callbackToken } = resolveInvocationCredentials();
  if (!apiUrl || !invocationId || !callbackToken) return null;
  return {
    apiUrl,
    headers: {
      'x-invocation-id': invocationId,
      'x-callback-token': callbackToken,
    },
  };
}

class PluginManagerHttpError extends Error {
  constructor(
    readonly status: number,
    readonly payload: string,
  ) {
    super(`Plugin Manager request failed (${status}): ${payload}`);
    this.name = 'PluginManagerHttpError';
  }
}

export function createPluginManagerHttpClient(options: PluginManagerHttpClientOptions = {}): PluginManagerClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const resolveAuth = options.resolveAuth ?? resolveCallbackAuth;

  async function request(path: string, init: RequestInit = {}): Promise<unknown> {
    const auth = resolveAuth();
    if (!auth) throw new Error(NO_CONFIG_ERROR);
    const headers: Record<string, string> = {
      ...auth.headers,
      origin: new URL(auth.apiUrl).origin,
    };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetchImpl(`${auth.apiUrl}${path}`, { ...init, headers });
    if (!response.ok) {
      throw new PluginManagerHttpError(response.status, await response.text());
    }
    return response.json();
  }

  function mutation(path: string, body: unknown): Promise<unknown> {
    return request(path, { method: 'POST', body: JSON.stringify(body) });
  }

  return {
    list: () => request('/api/plugin-manager/plugins'),
    search: (query) => {
      const params = new URLSearchParams({ q: query });
      return request(`/api/plugin-manager/plugins/search?${params.toString()}`);
    },
    get: (pluginId) => request(`/api/plugin-manager/plugins/${encodeURIComponent(pluginId)}`),
    listTools: (pluginId) => request(`/api/plugin-manager/plugins/${encodeURIComponent(pluginId)}/contributions/tools`),
    call: (pluginId, contributionId, toolName, args) =>
      mutation(`/api/plugin-manager/plugins/${encodeURIComponent(pluginId)}/contributions/call`, {
        contributionId,
        toolName,
        arguments: { ...args },
      }),
    install: (installRequest) => mutation('/api/plugin-manager/plugins/install', installRequest),
    setEnabled: (pluginId, setEnabledRequest) =>
      mutation(`/api/plugin-manager/plugins/${encodeURIComponent(pluginId)}/set-enabled`, setEnabledRequest),
    uninstall: (pluginId, uninstallRequest) =>
      mutation(`/api/plugin-manager/plugins/${encodeURIComponent(pluginId)}/uninstall`, uninstallRequest),
  };
}

type PluginManagementHandlers = {
  list(input: Record<string, never>): Promise<ToolResult>;
  search(input: { query: string }): Promise<ToolResult>;
  get(input: { pluginId: string }): Promise<ToolResult>;
  listTools(input: { pluginId: string }): Promise<ToolResult>;
  call(input: {
    pluginId: string;
    contributionId: string;
    toolName: string;
    arguments: Record<string, unknown>;
  }): Promise<ToolResult>;
  install(input: { request: PluginManagerInstallRequest }): Promise<ToolResult>;
  setEnabled(input: { pluginId: string; enabled: boolean; expectedRevision: number }): Promise<ToolResult>;
  uninstall(input: { pluginId: string; expectedRevision: number }): Promise<ToolResult>;
};

async function asToolResult(operation: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return successResult(JSON.stringify(await operation(), null, 2));
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}

export function createPluginManagementHandlers(client: PluginManagerClient): PluginManagementHandlers {
  return {
    list: async () => asToolResult(() => client.list()),
    search: async ({ query }) => asToolResult(() => client.search(query)),
    get: async ({ pluginId }) => asToolResult(() => client.get(pluginId)),
    listTools: async ({ pluginId }) => asToolResult(() => client.listTools(pluginId)),
    call: async ({ pluginId, contributionId, toolName, arguments: args }) =>
      asToolResult(() => client.call(pluginId, contributionId, toolName, args)),
    install: async ({ request }) => asToolResult(() => client.install(request)),
    setEnabled: async ({ pluginId, enabled, expectedRevision }) =>
      asToolResult(() => client.setEnabled(pluginId, { enabled, expectedRevision })),
    uninstall: async ({ pluginId, expectedRevision }) =>
      asToolResult(() => client.uninstall(pluginId, { expectedRevision })),
  };
}

const handlers = createPluginManagementHandlers(createPluginManagerHttpClient());

export const pluginManagementTools = [
  defineTool({
    name: 'plugin_list',
    description:
      'List the Host-owned plugin projection. Use when the user asks which plugins are available/installed or before any plugin mutation. NOT for: text matching (use plugin_search), one known id (use plugin_get), or changing state. Output: a read-only catalog status plus plugins with independent config/auth/intent/live axes, capabilities, lifecycleRevision, and allowed actions; no state changes.',
    inputSchema: pluginListInputSchema,
    handler: handlers.list,
    governance: {
      implementationExport: 'handlePluginList',
      action: 'list',
      risk: { level: 'read', openWorld: true },
      runtimeProfiles: ['full', 'readonly'],
      targetExposure: 'lazy-discoverable',
      standaloneReason: {
        disposition: 'accepted-boundary',
        kind: 'resource-entry',
        admissionRef: SPEC_REF,
      },
    },
  }),
  defineTool({
    name: 'plugin_search',
    description:
      'Search the verified Host plugin projection by id, localized description, publisher, package, or capability. Use when the user describes a plugin or capability but does not know its exact id. NOT for: reading one known id (use plugin_get) or installing/changing state. Output: a read-only filtered plugin list plus explicit catalog freshness; catalog failure never erases installed rows.',
    inputSchema: pluginSearchInputSchema,
    handler: handlers.search,
    governance: {
      implementationExport: 'handlePluginSearch',
      action: 'search',
      risk: { level: 'read', openWorld: true },
      runtimeProfiles: ['full', 'readonly'],
      targetExposure: 'lazy-discoverable',
      standaloneReason: {
        disposition: 'accepted-boundary',
        kind: 'progressive-disclosure',
        admissionRef: SPEC_REF,
      },
    },
  }),
  defineTool({
    name: 'plugin_get',
    description:
      'Read one known plugin from the Host-owned projection. Use when inspecting exact metadata, prerequisites, diagnostics, actions, or the current revision before enable/disable/uninstall. NOT for: catalog discovery (use plugin_list/search) or mutations. Output: one read-only detail with config fields, capabilities, diagnostics, allowed actions, and lifecycleRevision; no state changes.',
    inputSchema: pluginGetInputSchema,
    handler: handlers.get,
    governance: {
      implementationExport: 'handlePluginGet',
      action: 'get',
      risk: { level: 'read', openWorld: true },
      runtimeProfiles: ['full', 'readonly'],
      targetExposure: 'lazy-discoverable',
      standaloneReason: {
        disposition: 'accepted-boundary',
        kind: 'progressive-disclosure',
        admissionRef: SPEC_REF,
      },
    },
  }),
  defineTool({
    name: 'plugin_list_tools',
    description:
      'List callable tool schemas from one currently active Host-supervised plugin. Use when the user asks to use an installed plugin capability and after plugin_get confirms it is enabled/running. NOT for: catalog discovery, lifecycle changes, or guessing a tool schema. Output: active contribution ids, exact dynamic tool names, descriptions, and input schemas; no plugin process or authority is created.',
    inputSchema: pluginListToolsInputSchema,
    handler: handlers.listTools,
    governance: {
      implementationExport: 'handlePluginListTools',
      action: 'list-tools',
      risk: { level: 'read', openWorld: true },
      runtimeProfiles: ['full', 'readonly'],
      targetExposure: 'lazy-discoverable',
      standaloneReason: {
        disposition: 'accepted-boundary',
        kind: 'progressive-disclosure',
        admissionRef: SPEC_REF,
      },
    },
  }),
  defineTool({
    name: 'plugin_call',
    description:
      "Invoke one exact tool on a currently active Host-supervised plugin contribution. Use only when the user asks to perform that plugin capability after reading its schema with plugin_list_tools. NOT for: install, configuration, lifecycle changes, direct MCP process launch, or guessed arguments. Output/side effect: returns the plugin MCP result and may cause the dynamic tool's declared external effects; Host rechecks live instance and grant authority before every call, and secrets remain inside Host supervision.",
    inputSchema: pluginCallInputSchema,
    handler: handlers.call,
    governance: {
      implementationExport: 'handlePluginCall',
      action: 'invoke',
      risk: { level: 'write', openWorld: true },
      runtimeProfiles: ['full'],
      targetExposure: 'lazy-discoverable',
      standaloneReason: {
        disposition: 'accepted-boundary',
        kind: 'side-effect-boundary',
        admissionRef: SPEC_REF,
      },
    },
  }),
  defineTool({
    name: 'plugin_install',
    description:
      'Install a catalog candidate or local directory/archive through Host package admission and inventory. Use only when the user explicitly asks to install/add that plugin. NOT for: arbitrary npm search, enable, update, repair, or bypassing package verification. Output/side effect: admits an immutable verified package and disabled instance, returning its ids; catalog requests require the exact observed version/digest, and local code is never imported into the API process.',
    inputSchema: pluginInstallInputSchema,
    handler: handlers.install,
    governance: {
      implementationExport: 'handlePluginInstall',
      action: 'install',
      risk: { level: 'write', openWorld: true },
      runtimeProfiles: ['full'],
      targetExposure: 'lazy-discoverable',
      standaloneReason: {
        disposition: 'accepted-boundary',
        kind: 'side-effect-boundary',
        admissionRef: SPEC_REF,
      },
    },
  }),
  defineTool({
    name: 'plugin_set_enabled',
    description:
      'Enable or disable an installed plugin through the Host lifecycle controller. Use only when the user explicitly asks to start/enable or stop/disable it. NOT for: install, configuration, authentication, update, or repair. Output/side effect: changes activation intent/runtime authority and returns the instance id; pass the exact current lifecycleRevision, and stale requests have zero side effects.',
    inputSchema: pluginSetEnabledInputSchema,
    handler: handlers.setEnabled,
    governance: {
      implementationExport: 'handlePluginSetEnabled',
      action: 'set-enabled',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles: ['full'],
      targetExposure: 'lazy-discoverable',
      standaloneReason: {
        disposition: 'accepted-boundary',
        kind: 'side-effect-boundary',
        admissionRef: SPEC_REF,
      },
    },
  }),
  defineTool({
    name: 'plugin_uninstall',
    description:
      'Uninstall one plugin through the Host lifecycle controller. Use only when the user explicitly asks to remove/uninstall it. NOT for: temporary stopping (use plugin_set_enabled false), update, repair, or undeclared data deletion. Output/side effect: revokes runtime and grants before retiring the instance, then returns its ids; pass the exact current lifecycleRevision, and stale or revoke failures remain installed and fail closed.',
    inputSchema: pluginUninstallInputSchema,
    handler: handlers.uninstall,
    governance: {
      implementationExport: 'handlePluginUninstall',
      action: 'uninstall',
      risk: { level: 'destructive', openWorld: false },
      runtimeProfiles: ['full'],
      targetExposure: 'lazy-discoverable',
      standaloneReason: {
        disposition: 'accepted-boundary',
        kind: 'destructive-boundary',
        admissionRef: SPEC_REF,
      },
    },
  }),
] as const;

export const handlePluginList = handlers.list;
export const handlePluginSearch = handlers.search;
export const handlePluginGet = handlers.get;
export const handlePluginListTools = handlers.listTools;
export const handlePluginCall = handlers.call;
export const handlePluginInstall = handlers.install;
export const handlePluginSetEnabled = handlers.setEnabled;
export const handlePluginUninstall = handlers.uninstall;
