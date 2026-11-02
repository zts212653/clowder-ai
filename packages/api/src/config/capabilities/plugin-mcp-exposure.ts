import { isAbsolute } from 'node:path';
import type { CapabilitiesConfig } from '@cat-cafe/shared';
import type { InvocationPluginMcpEntry, InvocationPluginMcpView } from './invocation-plugin-mcp-view.js';
import { isSameCapabilityRoot } from './invoke-capability-root.js';

/** Supplied only by the trusted invocation or an authorized read-side adapter. */
export type PluginMcpExposureScope =
  | { readonly kind: 'member'; readonly projectRoot: string; readonly memberCatId: string }
  | { readonly kind: 'diagnostic'; readonly projectRoot: string };

export interface LocalPluginMcpProjection {
  readonly config: CapabilitiesConfig;
  readonly localCapabilityIds: ReadonlySet<string>;
  readonly sourceRefs: readonly string[];
}

/** Preserve the canonical ThreadStore project even if native workspace recovery used a fallback. */
export function pluginMcpExposureProject(threadProjectPath: string | undefined, workingDirectory: string | undefined) {
  return threadProjectPath && threadProjectPath !== 'default' ? threadProjectPath : workingDirectory;
}

function indexLocalEntries(entries: readonly InvocationPluginMcpEntry[]) {
  const counts = new Map<string, number>();
  const names = new Map<string, number>();
  const pluginSources = new Map<string, Set<string | undefined>>();
  for (const entry of entries) {
    counts.set(entry.capabilityId, (counts.get(entry.capabilityId) ?? 0) + 1);
    const name = entry.capabilityId.replaceAll(':', '__');
    names.set(name, (names.get(name) ?? 0) + 1);
    const sources = pluginSources.get(entry.pluginId) ?? new Set();
    sources.add(entry.policySourceRef);
    pluginSources.set(entry.pluginId, sources);
  }
  return { counts, names, pluginSources };
}

/** Add only Host-installed policies in this Host's own project, without publishing them. */
export function projectLocalPluginMcpCapabilities(
  config: CapabilitiesConfig,
  view: InvocationPluginMcpView | undefined,
  scope: PluginMcpExposureScope | undefined,
  memberCatId?: string,
): LocalPluginMcpProjection {
  const localCapabilityIds = new Set<string>();
  const sourceRefs: string[] = [];
  const unchanged = { config, localCapabilityIds, sourceRefs };
  if (!view?.localCapabilityRoot || !scope?.projectRoot) return unchanged;
  if (!isAbsolute(scope.projectRoot) || !isAbsolute(view.localCapabilityRoot)) return unchanged;
  // The original calling project is required: a missing external config can fall back to global.
  if (!isSameCapabilityRoot(scope.projectRoot, view.localCapabilityRoot)) return unchanged;
  if (scope.kind === 'member' && scope.memberCatId !== memberCatId) return unchanged;

  const { counts, names, pluginSources } = indexLocalEntries(view.entries);
  const known = new Set(config.capabilities.map((entry) => entry.id));
  const knownNames = new Set(config.capabilities.map((entry) => entry.id.replaceAll(':', '__')));
  const additions: CapabilitiesConfig['capabilities'] = [];
  for (const entry of view.entries) {
    const policy = entry.installationPolicy;
    if (
      known.has(entry.capabilityId) ||
      knownNames.has(entry.capabilityId.replaceAll(':', '__')) ||
      counts.get(entry.capabilityId) !== 1 ||
      names.get(entry.capabilityId.replaceAll(':', '__')) !== 1 ||
      pluginSources.get(entry.pluginId)?.size !== 1 ||
      !policy ||
      policy.id !== entry.capabilityId ||
      policy.type !== 'mcp' ||
      policy.source !== 'plugin' ||
      policy.pluginId !== entry.pluginId ||
      !entry.policySourceRef ||
      !entry.isCurrent()
    )
      continue;
    additions.push({
      ...structuredClone(policy),
      mcpServer: { ...entry.server, args: [...entry.server.args], env: { ...entry.server.env } },
    });
    localCapabilityIds.add(entry.capabilityId);
    sourceRefs.push(entry.policySourceRef);
  }
  return additions.length
    ? { config: { ...config, capabilities: [...config.capabilities, ...additions] }, localCapabilityIds, sourceRefs }
    : unchanged;
}
