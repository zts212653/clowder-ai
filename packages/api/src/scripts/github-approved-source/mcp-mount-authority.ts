import { resolve } from 'node:path';
import type { CapabilityEntry } from '@cat-cafe/shared';
import type { PluginInventorySnapshot } from '../../domains/plugin/host-inventory/types.js';
import { APPROVAL } from './approved-scope.js';

export const GITHUB_MCP_ID = 'plugin:official.github-operations:github-tracking';
export const RECOVERY_INSTANCE = 'pi_2033aea0-229d-4554-a309-7dca009ddd12';

/** Authenticate the source as the already admitted declaration. No credentials
 * are created or returned separately; the descriptor stays opaque in-process. */
export function verifyGitHubMcpMount(snapshot: PluginInventorySnapshot, entry: CapabilityEntry | undefined) {
  const instances = snapshot.instances.filter(
    (i) => i.pluginId === 'official.github-operations' && i.lifecycleState === 'installed',
  );
  const instance = instances[0];
  if (
    instances.length !== 1 ||
    !instance ||
    instance.pluginInstanceId !== RECOVERY_INSTANCE ||
    instance.packageDigest !== APPROVAL.archiveDigest ||
    instance.activationState !== 'enabled' ||
    instance.runtimeState !== 'healthy'
  )
    throw new Error('Exact healthy approved instance required');
  const pkg = snapshot.packages.find((p) => p.packageDigest === APPROVAL.archiveDigest);
  const declaration = pkg?.manifest?.contributions?.find((c) => c.type === 'mcp' && c.id === 'github-tracking');
  if (
    pkg?.pluginId !== 'official.github-operations' ||
    pkg.packageState !== 'installed' ||
    declaration?.type !== 'mcp' ||
    declaration.runtime.transport !== 'stdio'
  )
    throw new Error('Installed native binding declaration required');
  const server = entry?.mcpServer;
  if (
    !entry ||
    entry.id !== GITHUB_MCP_ID ||
    entry.type !== 'mcp' ||
    entry.pluginId !== pkg.pluginId ||
    entry.source !== 'plugin' ||
    !entry.enabled ||
    entry.globalEnabled === false ||
    !server?.workingDir ||
    server.transport !== 'stdio' ||
    !server.command ||
    !server.args ||
    server.args[0] !== resolve(server.workingDir, declaration.runtime.entrypoint) ||
    JSON.stringify(server.args.slice(1)) !== JSON.stringify(declaration.runtime.args ?? [])
  )
    throw new Error('Source MCP is not the exact Host declaration');
  const env = server.env ?? {};
  if (
    Object.keys(env).some((k) => !['CLOWDER_PLUGIN_ACTION_TOKEN', 'CLOWDER_PLUGIN_ACTION_PATH'].includes(k)) ||
    !/^[a-f0-9]{64}$/.test(env.CLOWDER_PLUGIN_ACTION_TOKEN ?? '') ||
    env.CLOWDER_PLUGIN_ACTION_PATH !== '/api/plugin-runtime/action'
  )
    throw new Error('Source transport environment is not the Host-issued connection');
  return { entry, workingDir: server.workingDir };
}

export function assertMcpMountTarget(entries: readonly CapabilityEntry[], source: CapabilityEntry) {
  const matches = entries.filter((e) => e.id === GITHUB_MCP_ID);
  if (
    matches.length > 1 ||
    matches.some(
      (e) =>
        e.type !== 'mcp' ||
        e.pluginId !== source.pluginId ||
        e.source !== 'plugin' ||
        e.globalEnabled === false ||
        e.enabled === false ||
        e.mcpServerOverride,
    )
  )
    throw new Error('Existing target conflicts with this installation or owner policy');
  return matches[0];
}
