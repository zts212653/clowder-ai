import type { SharedMcpFamily } from '@cat-cafe/mcp-server/dist/shared-invocation-context.js';
import { catRegistry } from '@cat-cafe/shared';
import {
  resolveAcpMcpServers,
  resolveDisabledServerIds,
} from '../../domains/cats/services/agents/providers/acp/acp-mcp-resolver.js';
import { resolveActiveProjectRoot } from '../../utils/active-project-root.js';
import { getAcpConfig } from '../cat-config-loader.js';
import { resolveBinaryRoot, resolveServersForCat } from './capability-orchestrator.js';
import { assertMappedCapabilitySource } from './invoke-capability-root.js';
import { readInvocationMcpConfig } from './invoke-mcp-config.js';
import { CAT_CAFE_SPLIT_ENTRYPOINTS, isManagedCatCafeSplit } from './mcp-constants.js';

/** One canonical configuration resolution for the launch bound and each currentness check. */
export async function resolveConfiguredMemberMcpFamilies(
  capabilityRoot: string,
  catId: string,
  workingDirectory?: string,
): Promise<readonly SharedMcpFamily[]> {
  // Member liveness/config belongs to the loaded runtime registry, never the
  // directory that owns persistent or project-local capability settings.
  const member = catRegistry.tryGet(catId)?.config;
  if (member?.mcpSupport !== true) return [];
  const memberRoot = resolveActiveProjectRoot();
  const acp = member.carrier === 'acp' ? getAcpConfig(catId, memberRoot) : undefined;
  if (member.carrier === 'acp' && !acp) return [];
  const { config, configSourceRoot, accessScope } = readInvocationMcpConfig(capabilityRoot, workingDirectory);
  assertMappedCapabilitySource(config !== null, resolveBinaryRoot(capabilityRoot), capabilityRoot);
  let names: string[];
  if (acp) {
    const whitelist = acp.mcpWhitelist ?? [];
    const servers = await resolveAcpMcpServers(memberRoot, whitelist, undefined, {
      mcpSupport: true,
      catId,
      capabilitiesConfig: config,
      configSourceRoot,
      disabledServerIds: resolveDisabledServerIds(memberRoot, catId, config),
    });
    names = servers.map((server) => server.name);
  } else {
    names = config
      ? resolveServersForCat(config, catId, { accessScope })
          .filter((server) => server.enabled && isManagedCatCafeSplit(server))
          .map((server) => server.name)
      : [...CAT_CAFE_SPLIT_ENTRYPOINTS.keys()];
  }
  return [
    ...new Set(
      names.flatMap((name) => {
        const entry = CAT_CAFE_SPLIT_ENTRYPOINTS.get(name);
        return entry ? [entry.slice(0, -3) as SharedMcpFamily] : [];
      }),
    ),
  ];
}
