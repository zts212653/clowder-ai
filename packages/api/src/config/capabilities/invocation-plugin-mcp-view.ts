import { AsyncLocalStorage } from 'node:async_hooks';
import type { CapabilityEntry, PluginMcpToolIssue } from '@cat-cafe/shared';
import { type PluginMcpExposureScope, projectLocalPluginMcpCapabilities } from './plugin-mcp-exposure.js';

export interface InvocationPluginMcpEntry {
  readonly capabilityId: string;
  readonly pluginId: string;
  readonly installationPolicy?: Omit<CapabilityEntry, 'mcpServer' | 'mcpServerOverride'>;
  readonly policySourceRef?: string;
  /** Host-only projection; never persisted or accepted as package-supplied caller authority. */
  readonly sharedHttpPath?: string;
  readonly sharedHttpUnavailableReason?: string;
  readonly server: {
    readonly command: string;
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    readonly transport: 'stdio';
    readonly workingDir: string;
  };
  readonly isCurrent: () => boolean;
}

/** A Host-owned read projection of verified activations and installation policy, never stored state. */
export interface InvocationPluginMcpView {
  readonly entries: readonly InvocationPluginMcpEntry[];
  readonly localCapabilityRoot?: string;
  /** Admission-only check owned by the activation source, including additions to an empty view. */
  readonly isCurrent?: () => boolean;
}

const invocationView = new AsyncLocalStorage<{
  readonly view: InvocationPluginMcpView | undefined;
  readonly scope: PluginMcpExposureScope | undefined;
  readonly toolIssues: PluginMcpToolIssue[];
}>();

/** Explain an optional capability rejection without treating it as a member connection failure. */
export function invocationPluginMcpIssues() {
  return [...(invocationView.getStore()?.toolIssues ?? [])];
}

export function invocationPluginMcpHttpPaths(servers: Record<string, Record<string, unknown>>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of invocationView.getStore()?.view?.entries ?? []) {
    const server = servers[entry.capabilityId.replaceAll(':', '__')];
    if (!server || !entry.sharedHttpPath || !entry.isCurrent()) continue;
    const env = server.env as Record<string, unknown> | undefined;
    if (
      server.command !== entry.server.command ||
      JSON.stringify(server.args) !== JSON.stringify(entry.server.args) ||
      env?.CLOWDER_PLUGIN_ACTION_TOKEN !== entry.server.env.CLOWDER_PLUGIN_ACTION_TOKEN
    )
      continue;
    result[entry.capabilityId.replaceAll(':', '__')] = entry.sharedHttpPath;
  }
  return result;
}

/** Admission needs the same verified activation projection before a provider iterator exists. */
export function withInvocationPluginMcpView<T>(
  run: () => T,
  view: InvocationPluginMcpView | undefined,
  scope?: PluginMcpExposureScope,
): T {
  return invocationView.run({ view, scope: scope ? Object.freeze({ ...scope }) : undefined, toolIssues: [] }, run);
}

export function invocationPluginMcpConfig(config: import('@cat-cafe/shared').CapabilitiesConfig, memberCatId: string) {
  const context = invocationView.getStore();
  if (context) context.toolIssues.length = 0;
  return projectLocalPluginMcpCapabilities(config, context?.view, context?.scope, memberCatId).config;
}

export function projectInvocationPluginMcp(
  capability: CapabilityEntry,
  enabled = true,
): {
  capability: CapabilityEntry;
  available: boolean;
} {
  if (!enabled) return { capability, available: false };
  const view = invocationView.getStore()?.view;
  if (!view || capability.type !== 'mcp' || !capability.pluginId || capability.mcpServerOverride)
    return { capability, available: true };
  const matches = view.entries.filter(
    (entry) => entry.capabilityId === capability.id && entry.pluginId === capability.pluginId,
  );
  const local = matches.length === 1 ? matches[0] : undefined;
  // An isolated Host must not fall back to a different deployment's activation.
  if (!local || !local.isCurrent()) return { capability, available: false };
  if (local.sharedHttpUnavailableReason === 'tool_schema_invalid') {
    const issues = invocationView.getStore()?.toolIssues;
    if (issues && !issues.some((issue) => issue.capabilityId === capability.id))
      issues.push({ pluginId: local.pluginId, capabilityId: capability.id, reasonCode: 'tool_schema_invalid' });
    return { capability, available: false };
  }
  return {
    available: true,
    capability: {
      ...capability,
      mcpServer: {
        ...capability.mcpServer,
        ...local.server,
        args: [...local.server.args],
        env: { ...local.server.env },
      },
    },
  };
}

/** Iterators execute lazily: scope next/return/throw, rather than just their construction. */
export function bindInvocationPluginMcpView<T>(
  create: () => AsyncIterator<T>,
  view: InvocationPluginMcpView | undefined,
  scope?: PluginMcpExposureScope,
): AsyncIterator<T> {
  const context = { view, scope: scope ? Object.freeze({ ...scope }) : undefined, toolIssues: [] };
  const iterator = invocationView.run(context, create);
  return {
    next: () => invocationView.run(context, () => iterator.next()),
    ...(iterator.return ? { return: () => invocationView.run(context, () => iterator.return!()) } : {}),
    ...(iterator.throw
      ? { throw: (error?: unknown) => invocationView.run(context, () => iterator.throw!(error)) }
      : {}),
  };
}
