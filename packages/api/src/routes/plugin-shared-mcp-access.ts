import { catRegistry } from '@cat-cafe/shared';
import { resolveServersForCat } from '../config/capabilities/capability-orchestrator.js';
import { readInvocationMcpConfig } from '../config/capabilities/invoke-mcp-config.js';
import {
  pluginMcpExposureProject,
  projectLocalPluginMcpCapabilities,
} from '../config/capabilities/plugin-mcp-exposure.js';
import { getAcpConfig } from '../config/cat-config-loader.js';
import type { InvocationRecord } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import {
  resolveAcpMcpServers,
  resolveDisabledServerIds,
} from '../domains/cats/services/agents/providers/acp/acp-mcp-resolver.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { PluginRuntimeCarrierRouter } from '../domains/plugin/carrier/runtime-carrier.js';
import { NativePluginActionError } from '../domains/plugin/declared/native-plugin-actions.js';
import { resolveActiveProjectRoot } from '../utils/active-project-root.js';

/** Uses the same project/member policy as invoke-time discovery, including ACP's configured surface. */
export async function assertSharedPluginMcpAccess(
  record: InvocationRecord,
  target: { capabilityId: string; pluginId: string },
  deps: {
    threadStore: Pick<IThreadStore, 'get'>;
    supervisor: Pick<PluginRuntimeCarrierRouter, 'resolveMemberMcpView'>;
  },
): Promise<string> {
  const deny = () => new NativePluginActionError(403, 'Plugin MCP capability is unavailable');
  const member = catRegistry.tryGet(record.catId)?.config;
  if (!record.sharedMcpContext || record.toolExecutionPolicy || member?.mcpSupport !== true) throw deny();
  const thread = await deps.threadStore.get(record.threadId);
  if (!thread || thread.deletedAt || thread.createdBy !== record.userId) throw deny();
  const projectRoot = pluginMcpExposureProject(thread.projectPath, record.sharedMcpContext.workspaceRoot);
  if (!projectRoot) throw deny();
  const { config, accessScope, configSourceRoot } = readInvocationMcpConfig(
    record.sharedMcpContext.capabilityRoot,
    projectRoot,
  );
  // Local installation policy only fills absent declarations. An explicit project
  // declaration is already canonical and must still be read afresh on every check.
  // Resolving every unrelated activation cannot change that existing target policy.
  const projected = config?.capabilities.some((capability) => capability.id === target.capabilityId)
    ? config
    : projectLocalPluginMcpCapabilities(
        config ?? { version: 2, capabilities: [] },
        await deps.supervisor.resolveMemberMcpView(),
        { kind: 'member', projectRoot, memberCatId: record.catId },
        record.catId,
      ).config;
  const matches = projected.capabilities.filter((c) => c.id === target.capabilityId);
  const capability = matches.length === 1 ? matches[0] : undefined;
  if (!capability || capability.pluginId !== target.pluginId || capability.mcpServerOverride) throw deny();
  const name = target.capabilityId.replaceAll(':', '__');
  if (!resolveServersForCat(projected, record.catId, { accessScope }).some((s) => s.name === name && s.enabled))
    throw deny();
  if (member.carrier === 'acp') {
    const memberRoot = resolveActiveProjectRoot();
    const acp = getAcpConfig(record.catId, memberRoot);
    if (!acp) throw deny();
    const servers = await resolveAcpMcpServers(memberRoot, acp.mcpWhitelist ?? [], undefined, {
      mcpSupport: true,
      catId: record.catId,
      capabilitiesConfig: projected,
      configSourceRoot,
      accessScope,
      disabledServerIds: resolveDisabledServerIds(memberRoot, record.catId, projected, { accessScope }),
    });
    if (!servers.some((s) => s.name === name)) throw deny();
  }
  return projectRoot;
}
