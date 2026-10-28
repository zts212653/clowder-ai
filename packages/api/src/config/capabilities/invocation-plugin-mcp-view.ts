import { AsyncLocalStorage } from 'node:async_hooks';
import type { CapabilityEntry } from '@cat-cafe/shared';
import { type PluginMcpExposureScope, projectLocalPluginMcpCapabilities } from './plugin-mcp-exposure.js';

export interface InvocationPluginMcpEntry {
  readonly capabilityId: string;
  readonly pluginId: string;
  readonly installationPolicy?: Omit<CapabilityEntry, 'mcpServer' | 'mcpServerOverride'>;
  readonly policySourceRef?: string;
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
}

const invocationView = new AsyncLocalStorage<{
  readonly view: InvocationPluginMcpView | undefined;
  readonly scope: PluginMcpExposureScope | undefined;
}>();

export function invocationPluginMcpConfig(config: import('@cat-cafe/shared').CapabilitiesConfig, memberCatId: string) {
  const context = invocationView.getStore();
  return projectLocalPluginMcpCapabilities(config, context?.view, context?.scope, memberCatId).config;
}

export function projectInvocationPluginMcp(capability: CapabilityEntry): {
  capability: CapabilityEntry;
  available: boolean;
} {
  const view = invocationView.getStore()?.view;
  if (!view || capability.type !== 'mcp' || !capability.pluginId || capability.mcpServerOverride)
    return { capability, available: true };
  const matches = view.entries.filter(
    (entry) => entry.capabilityId === capability.id && entry.pluginId === capability.pluginId,
  );
  const local = matches.length === 1 ? matches[0] : undefined;
  // An isolated Host must not fall back to a different deployment's activation.
  if (!local || !local.isCurrent()) return { capability, available: false };
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
  const context = { view, scope: scope ? Object.freeze({ ...scope }) : undefined };
  const iterator = invocationView.run(context, create);
  return {
    next: () => invocationView.run(context, () => iterator.next()),
    ...(iterator.return ? { return: () => invocationView.run(context, () => iterator.return!()) } : {}),
    ...(iterator.throw
      ? { throw: (error?: unknown) => invocationView.run(context, () => iterator.throw!(error)) }
      : {}),
  };
}
