import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServerDescriptor } from '@cat-cafe/shared';
import {
  resolveBinaryRoot,
  resolvePencilCommand,
  resolveServersForCat,
} from '../../../../../config/capabilities/capability-orchestrator.js';
import {
  assertMappedCapabilitySource,
  resolveInvokeCapabilityRoot,
} from '../../../../../config/capabilities/invoke-capability-root.js';
import { readInvocationMcpConfig } from '../../../../../config/capabilities/invoke-mcp-config.js';
import {
  CAT_CAFE_SPLIT_ENTRYPOINTS,
  isManagedCatCafeSplit,
  resolveCatCafeNodeCommand,
} from '../../../../../config/capabilities/mcp-constants.js';
import {
  resolveMcpArgs,
  resolveMcpCommand,
  resolveMcpWorkingDir,
} from '../../../../../config/capabilities/mcp-launch-paths.js';
import { pluginMcpEnvironment } from '../../../../../config/capabilities/plugin-mcp-environment.js';
import { resolveEnvReferences } from '../../../../../utils/env-references.js';
import { findMonorepoRoot } from '../../../../../utils/monorepo-root.js';

export interface CodexMcpInputPlan {
  readonly available: boolean;
  readonly resolved: boolean;
  readonly allowedWorkspaceDirs: string;
  readonly servers: ReadonlyArray<McpServerDescriptor & { readonly catCafe: boolean; readonly plugin: boolean }>;
}

/** Capture existing Codex resolution rules; one-shot wrappers and callback credentials belong to launch. */
export async function captureCodexMcpInput(catId?: string, workingDirectory?: string): Promise<CodexMcpInputPlan> {
  const fileDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolveBinaryRoot(),
    process.cwd(),
    findMonorepoRoot(fileDir),
    resolve(fileDir, '../../../../../../../..'),
  ].filter((root): root is string => !!root);
  const mcpDistDir = candidates
    .map((root) => resolve(root, 'packages/mcp-server/dist'))
    .find((directory) => existsSync(resolve(directory, 'index.js')));
  if (!mcpDistDir) return { available: false, resolved: false, allowedWorkspaceDirs: '', servers: [] };
  const binaryRoot = resolve(mcpDistDir, '../../..');
  const capabilityRoot = await resolveInvokeCapabilityRoot(binaryRoot);
  const allowedWorkspaceDirs =
    process.env.ALLOWED_WORKSPACE_DIRS?.trim() ||
    (workingDirectory?.trim()
      ? resolve(workingDirectory.trim())
      : process.env.CAT_CAFE_WORKSPACE_ROOT?.trim() || process.cwd());
  const servers: Array<McpServerDescriptor & { catCafe: boolean; plugin: boolean }> = [];
  let resolved = false;
  try {
    const { config, configSourceRoot, accessScope } = readInvocationMcpConfig(capabilityRoot, workingDirectory);
    if (config && catId) {
      for (const server of resolveServersForCat(config, catId, { accessScope })) {
        if (!server.enabled) {
          servers.push({ ...server, env: undefined, headers: undefined, catCafe: false, plugin: false });
          continue;
        }
        if (server.resolver === 'pencil') {
          const pencil = await resolvePencilCommand({ projectRoot: configSourceRoot });
          servers.push({
            ...server,
            transport: 'stdio',
            enabled: Boolean(pencil),
            command: pencil?.command ?? 'echo',
            args: pencil?.args ?? ['disabled-shim'],
            env: undefined,
            headers: undefined,
            catCafe: false,
            plugin: false,
          });
          continue;
        }
        if (server.transport === 'streamableHttp' && server.url) {
          servers.push({
            ...server,
            headers: server.headers ? resolveEnvReferences(server.headers) : undefined,
            catCafe: false,
            plugin: false,
          });
          continue;
        }
        const catCafe = isManagedCatCafeSplit(server);
        const workingDir = resolveMcpWorkingDir(server.workingDir, configSourceRoot);
        if (catCafe) {
          const entrypoint = resolve(mcpDistDir, CAT_CAFE_SPLIT_ENTRYPOINTS.get(server.name)!);
          if (existsSync(entrypoint))
            servers.push({
              ...server,
              command: resolveCatCafeNodeCommand(),
              args: [entrypoint],
              workingDir,
              env: undefined,
              catCafe: true,
              plugin: false,
            });
        } else if (server.command) {
          const env = pluginMcpEnvironment(server, {});
          servers.push({
            ...server,
            command: resolveMcpCommand(server.command, workingDir, configSourceRoot),
            args: resolveMcpArgs(server.args, workingDir, configSourceRoot),
            workingDir,
            env,
            catCafe: false,
            plugin: server.source === 'plugin' && Boolean(env?.CLOWDER_PLUGIN_ACTION_TOKEN),
          });
        }
      }
      resolved = true;
    }
  } catch {
    // Preserve the existing best-effort fallback and already resolved entries.
  }
  assertMappedCapabilitySource(resolved, binaryRoot, capabilityRoot);
  if (!resolved)
    for (const [name, entrypoint] of CAT_CAFE_SPLIT_ENTRYPOINTS) {
      const path = resolve(mcpDistDir, entrypoint);
      if (existsSync(path))
        servers.push({
          name,
          command: resolveCatCafeNodeCommand(),
          args: [path],
          enabled: true,
          source: 'cat-cafe',
          catCafe: true,
          plugin: false,
        });
    }
  return structuredClone({ available: true, resolved, allowedWorkspaceDirs, servers });
}
